import express, {
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomBytes, timingSafeEqual } from "crypto";
import type { Address } from "viem";
import {
  loadConfig,
  saveConfig,
  resolveProfile,
  setConfigPath,
  parseConfigValue,
  redactConfigForDisplay,
} from "./config.js";
import { listChains, resolveToken, resolveTradePair, unknownTokenError } from "./chains.js";
import { registerAutomationRoutes, registerSignalWebhook } from "./webAutomation.js";
import { tradekitVersion } from "./version.js";
import { activeWalletAddress, activeWalletLabel, loadWallet, type WalletContext } from "./wallet.js";
import { listAccounts, setActiveAccount } from "./accounts.js";
import { executeTrade, type TradeRequest } from "./trade.js";
import { holdingsMultiChain } from "./holdings.js";
import { computePnL } from "./pnl.js";
import { recentTrades, recentAudit, closeDb, insertAudit, capAuditParams, redactSensitiveFields, matchesTradeToken } from "./db.js";
import { renderMetricsResponse } from "./metrics.js";
import { getCurrentPrice } from "./price.js";
import { searchToken, trendingOnChain } from "./trending.js";
import { ToolError, toToolError, httpStatusForCode } from "./errors.js";
import { parseDateFilter, dedupeFirstSeen } from "./format.js";
import { fetchWithTimeout } from "./http.js";
import { sanitizeForLogLine, type Logger } from "./logger.js";

export interface WebServerOptions {
  host: string;
  port: number;
  walletPass: string;
  logger: Logger;
}

interface ContextCache {
  [chain: string]: Promise<WalletContext>;
}

/** Constant-time token comparison. Falls back to length-mismatch fast-fail. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Find the bundled React assets. We resolve relative to this file's directory so the
 *  layout works whether installed via npm (dist/web.js + dist/webui/) or run from source. */
function resolveBundledWebui(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/web.js sibling of dist/webui/
  const candidate = join(here, "webui");
  if (existsSync(join(candidate, "index.html"))) return candidate;
  // src/web.ts at repo root → ../dist/webui (during local dev with tsc + vite build)
  const devCandidate = join(here, "..", "dist", "webui");
  if (existsSync(join(devCandidate, "index.html"))) return devCandidate;
  return null;
}

export async function startWebServer(opts: WebServerOptions): Promise<void> {
  const contextCache: ContextCache = {};
  const { logger } = opts;

  // Per-session random auth token (or honor TRADEKIT_WEB_TOKEN env for stable pinning).
  const token = process.env.TRADEKIT_WEB_TOKEN || randomBytes(24).toString("base64url");
  // Sanity-check the operator-supplied token: anything under 16 chars is trivially
  // guessable for a network-exposed wallet API. Don't refuse — operators may have
  // local-only setups with custom tooling that expects a specific short value — but
  // warn loudly so the choice is conscious. Pre-iter205 a `TRADEKIT_WEB_TOKEN=abc`
  // produced no signal that this was a security regression vs the default.
  if (process.env.TRADEKIT_WEB_TOKEN && process.env.TRADEKIT_WEB_TOKEN.length < 16) {
    logger.warn(
      `TRADEKIT_WEB_TOKEN is only ${process.env.TRADEKIT_WEB_TOKEN.length} chars — easily guessable. Use 24+ random chars, or unset the env var to use a fresh random token per run.`,
    );
  }

  async function getContext(
    chainName: string | undefined,
  ): Promise<WalletContext & { chain: string }> {
    const config = loadConfig();
    const chain = (chainName ?? config.activeChain).toLowerCase();
    if (!contextCache[chain]) {
      const profile = resolveProfile(chain, config);
      const extraRpcs = config.chains[chain]?.rpcs ?? [];
      contextCache[chain] = loadWallet(opts.walletPass, profile, extraRpcs, logger);
    }
    const wallet = await contextCache[chain];
    return { ...wallet, chain };
  }

  /**
   * Parse and validate a query-string integer (limit, etc). Same shape as
   * cli/helpers.ts parseIntFlag — pre-iter153 web routes used raw parseInt which
   * silently accepted "12abc" as 12 and turned non-numeric input into NaN, which
   * SQLite then coerced to LIMIT 0 (empty results, no diagnostic).
   */
  const parseQueryInt = (raw: unknown, label: string, opts: { min?: number; max?: number; defaultValue: number }) => {
    if (raw == null || raw === "") return opts.defaultValue;
    if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) {
      throw new ToolError("INVALID_PARAMS", `Invalid ${label} "${String(raw)}" — expected an integer.`);
    }
    const n = parseInt(raw, 10);
    const min = opts.min ?? 0;
    if (n < min) throw new ToolError("INVALID_PARAMS", `Invalid ${label} ${n} — must be ≥ ${min}.`);
    if (opts.max != null && n > opts.max) {
      throw new ToolError("INVALID_PARAMS", `Invalid ${label} ${n} — must be ≤ ${opts.max}.`);
    }
    return n;
  };

  // ── express setup ───────────────────────────────────────────
  const app = express();
  app.disable("x-powered-by");
  // Iter373: minimal defense-in-depth security headers for the local web UI.
  // - X-Frame-Options: DENY — prevents iframe embedding (clickjacking). The token-gate
  //   already prevents API actions from a foreign frame, but a phishing iframe could
  //   harvest the token via misleading UI ("enter token to continue"). DENY closes that.
  // - X-Content-Type-Options: nosniff — refuses browser MIME-sniffing on responses,
  //   so a maliciously-crafted JSON blob can't be interpreted as HTML/JS.
  // - Referrer-Policy: same-origin — the trading API URLs should not leak as Referer
  //   to any external link the operator clicks from the UI.
  // No CSP because we already disable inline scripts in the bundled webui; adding CSP
  // would require enumerating the exact bundle hashes and complicates dev iteration.
  // Operators who need stricter headers can front this with a reverse proxy.
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  // Express's default JSON serializer can't handle BigInt (which our allowances /
  // simulation results carry). Register a replacer that stringifies them.
  app.set("json replacer", (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

  // ── auth middleware ─────────────────────────────────────────
  const authMiddleware: RequestHandler = (req, res, next) => {
    // Three accepted token channels (same as before): Authorization: Bearer X, cookie tk_token, or ?token=X.
    const auth = req.header("authorization");
    if (auth && /^Bearer\s+(.+)$/i.test(auth)) {
      const m = /^Bearer\s+(.+)$/i.exec(auth)!;
      if (tokensMatch(m[1].trim(), token)) return next();
    }
    const cookie = req.header("cookie");
    if (cookie) {
      const m = /(?:^|;\s*)tk_token=([^;]+)/.exec(cookie);
      if (m && tokensMatch(decodeURIComponent(m[1]), token)) return next();
    }
    const q = typeof req.query.token === "string" ? req.query.token : "";
    if (q && tokensMatch(q, token)) return next();

    if (req.method === "GET" && (req.path === "/" || req.path === "/index.html")) {
      res
        .status(401)
        .type("html")
        .send(
          `<!doctype html><html><body style="font-family:ui-monospace,monospace;background:#0e1116;color:#e6edf3;padding:30px;line-height:1.5">` +
            `<h2 style="color:#f85149">401 Unauthorized</h2>` +
            `<p>Open the URL printed on the server's console — it includes the per-session <code>?token=…</code>.</p>` +
            `<p style="color:#8b949e">Or supply <code>Authorization: Bearer &lt;token&gt;</code>, or set the cookie <code>tk_token</code>.</p>` +
            `</body></html>`,
        );
      return;
    }
    res.status(401).json({
      ok: false,
      error: { code: "WALLET_LOCKED", message: "Unauthorized — missing or invalid token." },
    });
  };
  // ── v35: inbound signal webhook ──
  //
  // Mounted BEFORE the auth middleware — see registerSignalWebhook
  // for the auth + risk rationale.
  registerSignalWebhook(app, logger);

  // ── Prometheus /metrics endpoint ──
  //
  // Mounted BEFORE the auth middleware: Prometheus scrapers don't carry
  // the tk_token cookie, and the metrics endpoint is intended to be
  // openly scrapable from inside a trusted network (the canonical
  // Prometheus convention). Operators who DO want auth on this surface
  // gate it via a reverse proxy in front of the web server — same
  // pattern as auth on /metrics for kubelet, node_exporter, etc.
  //
  // Labels are bounded enums (status, chain, worker, error_code); we
  // never expose wallet addresses, USD values, or strategy tags. So
  // even a leaked /metrics fetch can't reveal operator-sensitive
  // dimensions — only deployment shape.
  app.get("/metrics", (_req, res) => {
    try {
      const { contentType, body } = renderMetricsResponse();
      res.setHeader("content-type", contentType);
      res.status(200).send(body);
    } catch (e) {
      // Surface a 500 — Prometheus marks this scrape as failed +
      // operator gets an alert via their scrape-health monitor.
      logger.error(`/metrics render failed: ${(e as Error).message}`);
      res.status(500).type("text/plain").send(`# render failed: ${(e as Error).message}\n`);
    }
  });
  // /healthz mirror — useful for load-balancer health checks. Returns
  // 200 OK as long as the Express handler runs; deeper readiness checks
  // (DB writable, RPC reachable) go through `tradekit doctor`.
  app.get("/healthz", (_req, res) => {
    res.status(200).type("text/plain").send("ok\n");
  });

  app.use(authMiddleware);

  // ── bootstrap GET / sets the cookie when ?token= is present ──
  app.get(["/", "/index.html"], (req, res, next) => {
    if (typeof req.query.token === "string") {
      // Set Secure when the request actually came over HTTPS (via a reverse proxy with
      // X-Forwarded-Proto, or directly). Defaults are host=127.0.0.1 plain HTTP, which
      // is fine — but if an operator binds to 0.0.0.0 behind nginx/Caddy on https, the
      // token cookie should be HTTPS-only so it can't leak over plaintext on the next
      // sub-resource fetch. Express's req.secure reads X-Forwarded-Proto when the app
      // has `trust proxy` set, but in the common case (no proxy or direct https) it
      // works from req.protocol.
      const isHttps = req.secure || req.header("x-forwarded-proto") === "https";
      const secureFlag = isHttps ? "; Secure" : "";
      res.setHeader(
        "Set-Cookie",
        `tk_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secureFlag}`,
      );
    }
    next();
  });

  // ── API routes (each one wraps its handler in this helper so errors → 400 with ToolError JSON) ──
  const wrap =
    (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res);
      } catch (e) {
        next(e);
      }
    };

  app.get(
    "/api/status",
    wrap((_req, res) => {
      const config = loadConfig();
      const file = listAccounts();
      const addr = activeWalletAddress();
      // Include custom-configured chains alongside built-ins so the web UI's chain
      // selector surfaces operator-defined chains too. Pre-iter231 the response
      // exposed only listChains() (built-ins); same blind spot iter161/211 fixed
      // elsewhere.
      const customChains = Object.keys(config.chains ?? {}).filter(
        (c) => !listChains().includes(c.toLowerCase()),
      );
      // Iter393: include tradekit + node version so monitoring scripts polling
      // /api/status across multiple deployments can track which version each is
      // running. Memoized via the shared helper — adds no per-request cost.
      res.json({
        ok: true,
        address: addr,
        // Iter507: route through activeWalletLabel so /api/status agrees with
        // /api/holdings + /api/trades + /api/pnl on the active label. Pre-iter507
        // /api/status read file?.active directly — in the orphan-accounts.json
        // case it returned "alice" while every other endpoint (iter502 fix) saw
        // "keystore". The frontend polling /api/status got one identity; an
        // ?account= filter against the same wallet got another.
        activeAccount: activeWalletLabel(),
        activeChain: config.activeChain,
        accounts: file?.accounts ?? [],
        chains: [...listChains(), ...customChains],
        version: { tradekit: tradekitVersion(), node: process.versions.node },
        // Iter248: snapshot timestamp for parity with the rest of the read endpoints
        // (iter218-247). /api/status is what the frontend polls every few seconds — a
        // freshness marker lets the UI display "last refreshed" without computing its
        // own clock-time on receipt.
        timestamp: new Date().toISOString(),
      });
    }),
  );

  app.get(
    "/api/config",
    wrap((_req, res) => {
      // Always redact: response is visible in browser DevTools / browser cache /
      // proxy logs. The web server proxies aggregator calls itself, so the browser
      // never needs the raw keys.
      res.json({ ok: true, config: redactConfigForDisplay(loadConfig()) });
    }),
  );
  app.post(
    "/api/config",
    wrap(async (req, res) => {
      const body = req.body as { path: string; value: unknown };
      if (!body.path) throw new ToolError("INVALID_PARAMS", "path is required");
      // Audit-wrap mutating config changes (matches MCP's `config { action: "set" }`
      // tool). The body itself may carry credentials in value — redactSensitiveFields
      // inside auditWrap walks the params so any key/secret in value gets redacted.
      const next = await auditWrap("config", body as unknown as Record<string, unknown>, undefined, async () => {
        const parsed = typeof body.value === "string" ? parseConfigValue(body.value) : body.value;
        const updated = setConfigPath(loadConfig(), body.path, parsed);
        saveConfig(updated);
        return updated;
      });
      res.json({ ok: true, config: redactConfigForDisplay(next) });
    }),
  );

  app.post(
    "/api/accounts/use",
    wrap(async (req, res) => {
      const body = req.body as { label: string };
      if (!body.label) throw new ToolError("INVALID_PARAMS", "label is required");
      const active = await auditWrap("accounts", { ...body, action: "use" }, undefined, async () => {
        const file = setActiveAccount(body.label);
        for (const k of Object.keys(contextCache)) delete contextCache[k];
        return file.active;
      });
      res.json({ ok: true, active });
    }),
  );

  app.get(
    "/api/chains",
    wrap((_req, res) => {
      const config = loadConfig();
      const customChains = Object.keys(config.chains ?? {}).filter(
        (c) => !listChains().includes(c.toLowerCase()),
      );
      const allNames = [...listChains(), ...customChains];
      type ChainEntry = { name: string; custom: boolean; profile?: unknown; incomplete?: true };
      const chains: ChainEntry[] = allNames.map((name) => {
        try {
          return { name, profile: resolveProfile(name, config), custom: customChains.includes(name) };
        } catch {
          // Incomplete custom-chain shell — surface as entry with `incomplete: true`
          // matching iter161's chains-command behavior rather than crashing the whole
          // endpoint via resolveProfile's throw.
          return { name, custom: true, incomplete: true };
        }
      });
      // Iter377: parity with CLI's chains command — include the activeChain and a
      // snapshot timestamp so the web UI doesn't have to combine /api/status +
      // /api/chains to know which entry is active.
      res.json({
        ok: true,
        activeChain: config.activeChain,
        chains,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  app.get(
    "/api/holdings",
    wrap(async (req, res) => {
      const config = loadConfig();
      // Validate ?address= before passing it deeper — pre-iter152 a malformed query
      // string like ?address=alice cast straight through and produced a confusing
      // viem contract-read error instead of a clean INVALID_PARAMS at the API
      // boundary.
      const rawAddress = typeof req.query.address === "string" ? req.query.address : undefined;
      const rawAccount = typeof req.query.account === "string" ? req.query.account : undefined;
      // Iter267: parity with CLI iter263/265 and MCP iter266. Pass EITHER ?address=
      // OR ?account= — never both. Pre-iter267 the web endpoint only accepted address
      // and silently ignored anything else, so a frontend that wanted "show me bob's
      // holdings" had to first POST /api/accounts/use to switch active, then GET — a
      // state-mutating workaround for what's really a per-request read.
      if (rawAddress && rawAccount) {
        throw new ToolError(
          "INVALID_PARAMS",
          `Pass either ?address= OR ?account=, not both. Got address="${rawAddress}" and account="${rawAccount}".`,
        );
      }
      if (rawAddress && !/^0x[0-9a-fA-F]{40}$/.test(rawAddress)) {
        throw new ToolError(
          "INVALID_PARAMS",
          `Invalid address "${rawAddress}" — expected 0x-prefixed 40 hex chars.`,
        );
      }
      let address: Address | undefined = rawAddress as Address | undefined;
      if (!address && rawAccount) {
        // Read-only address lookup. No password needed since we're not signing.
        // Iter284: also handle the synthetic "keystore" label that the accounts tool
        // returns for single-key wallets (iter234). Pre-iter284 `?account=keystore`
        // failed with UNKNOWN_ACCOUNT because the keystore-only path doesn't have
        // an accounts.json entry. Now: lowercase comparison against "keystore" hits
        // getKeystoreAddress() — matching the MCP accounts list shape.
        const file = listAccounts();
        const entry = file?.accounts.find((a) => a.label === rawAccount);
        if (entry) {
          address = entry.address;
        } else if (rawAccount.toLowerCase() === "keystore") {
          const ks = (await import("./wallet.js")).getKeystoreAddress();
          if (!ks) {
            throw new ToolError(
              "WALLET_NOT_FOUND",
              `account="keystore" requested but no single-key keystore exists. Run \`tradekit wallet create\` first, or use a different account label.`,
              { details: { requestedAccount: "keystore", reason: "keystore_requested_but_absent" } },
            );
          }
          address = ks;
        } else {
          // Iter382: parity with iter381's CLI holdings fix — route through
          // unknownAccountError so a typo'd ?account= surfaces the iter344 "Did you
          // mean" hint. Mixed set: HD labels + synthetic "keystore" label when a
          // single-key keystore exists.
          const { unknownAccountError } = await import("./accounts.js");
          const knownLabels = [
            ...(file?.accounts ?? []).map((a) => a.label),
            ...((await import("./wallet.js")).getKeystoreAddress() ? ["keystore"] : []),
          ];
          throw unknownAccountError(rawAccount, knownLabels);
        }
      }
      if (!address) address = activeWalletAddress() ?? undefined;
      if (!address) {
        throw new ToolError(
          "WALLET_NOT_FOUND",
          "No address, account, or active wallet found.",
          { details: { reason: "no_wallet" } },
        );
      }
      // Iter347: parity with the CLI's parseChainsFlag (iter134/iter346) — trim,
      // lowercase, dedupe. Pre-iter347 a query like `?chains=base, arbitrum,base` left
      // " arbitrum" (leading space) and a duplicate "base" in the array; the leading
      // space then failed resolveProfile with "Unknown chain  arbitrum" (visible double
      // space — confusing), and the duplicate doubled RPC traffic for that chain on
      // every multi-chain holdings request.
      let chains: string[] | undefined;
      if (typeof req.query.chains === "string") {
        const parsed = dedupeFirstSeen(
          req.query.chains.split(",").map((c) => c.trim().toLowerCase()).filter((c) => c.length > 0),
        );
        // Iter369: reject empty-after-split with INVALID_PARAMS to match the CLI's
        // parseChainsFlag guard. Pre-iter369 `?chains=,,,` resolved to `[]`, holdings
        // returned an empty {reports: [], errors: []}, and the operator got no signal
        // that their query was malformed. Empty array is truthy under `??`, so it
        // wasn't even falling through to the all-chains default — it was silently
        // scanning nothing. CLI throws "Invalid --chains '...' — expected a
        // comma-separated list." Now web does too.
        if (parsed.length === 0) {
          throw new ToolError("INVALID_PARAMS", `Invalid chains "${req.query.chains}" — expected a comma-separated list.`);
        }
        chains = parsed;
      }
      const { reports, errors } = await holdingsMultiChain(address, config, logger, chains);
      res.json({ ok: true, reports, errors });
    }),
  );

  app.get(
    "/api/trades",
    wrap((req, res) => {
      const chain = (req.query.chain as string | undefined) ?? undefined;
      const account =
        // Iter502: route through activeWalletLabel — orphan-accounts.json case
        // returns "keystore" matching what loadWallet would use, instead of the
        // dead HD label (iter499 / iter500 / iter501 arc).
        (req.query.account as string | undefined) ?? activeWalletLabel();
      const limit = parseQueryInt(req.query.limit, "limit", { min: 1, max: 100_000, defaultValue: 100 });
      // Iter357: ?since parity with /api/audit. Same iter356 shortcuts (today, 24h, 7d).
      const sinceIso = parseDateFilter(req.query.since as string | undefined, "since");
      let trades = recentTrades({ chain, account, limit, since: sinceIso });
      // Mirror the CLI's iter57 filters so the Web UI can offer the same retrieval.
      // status: success | failed | pending — find timed-out trades after a TX_TIMEOUT.
      // token:  case-insensitive match against base/quote symbol or token address.
      // note:   case-insensitive substring against the `notes` column (campaign tags).
      // Iter241: match the CLI's iter130 validation + lowercasing. Pre-iter241 a
      // capitalised "?status=Failed" silently returned [] because the DB stores
      // lowercase; an unknown value like "?status=cancelled" silently returned
      // everything because the filter just no-op'd. Both were caller-side bugs that
      // looked like data bugs. Now the API returns 400 INVALID_PARAMS up front.
      const statusFilter = (req.query.status as string | undefined)?.toLowerCase();
      if (statusFilter) {
        const VALID = new Set(["pending", "success", "failed"]);
        if (!VALID.has(statusFilter)) {
          throw new ToolError(
            "INVALID_PARAMS",
            `Invalid status "${req.query.status}" — expected one of: ${[...VALID].join(", ")}.`,
          );
        }
        trades = trades.filter((t) => t.status === statusFilter);
      }
      const tokenFilter = (req.query.token as string | undefined)?.toLowerCase();
      if (tokenFilter) {
        // Same predicate as CLI/MCP via matchesTradeToken (iter282 extracted shared).
        trades = trades.filter((t) => matchesTradeToken(t, tokenFilter));
      }
      const noteFilter = (req.query.note as string | undefined)?.toLowerCase();
      if (noteFilter) {
        trades = trades.filter((t) => (t.notes ?? "").toLowerCase().includes(noteFilter));
      }
      res.json({ ok: true, trades });
    }),
  );

  app.get(
    "/api/pnl",
    wrap(async (req, res) => {
      const chain = (req.query.chain as string | undefined) ?? undefined;
      const account =
        // Iter502: route through activeWalletLabel — orphan-accounts.json case
        // returns "keystore" matching what loadWallet would use, instead of the
        // dead HD label (iter499 / iter500 / iter501 arc).
        (req.query.account as string | undefined) ?? activeWalletLabel();
      const report = await computePnL(account, { chain }, logger);
      res.json({ ok: true, report });
    }),
  );

  app.get(
    "/api/audit",
    wrap((req, res) => {
      const limit = parseQueryInt(req.query.limit, "limit", { min: 1, max: 100_000, defaultValue: 100 });
      // Filters mirror the CLI (`tradekit audit --tool X --account Y --chain Z --since D`)
      // and the MCP `audit` tool. Server-side via recentAudit so we don't ship huge result
      // sets just to discard them client-side.
      const sinceIso = parseDateFilter(req.query.since as string | undefined, "since");
      // Iter370: validate ?caller like the CLI does. Pre-iter370 `?caller=banana` (and
      // CLI's --caller banana) silently no-op'd in the DB filter and returned 0 rows.
      const callerFilter = (req.query.caller as string | undefined)?.toLowerCase();
      if (callerFilter) {
        const VALID = new Set(["cli", "mcp", "web"]);
        if (!VALID.has(callerFilter)) {
          throw new ToolError(
            "INVALID_PARAMS",
            `Invalid caller "${req.query.caller}" — expected one of: ${[...VALID].join(", ")}.`,
          );
        }
      }
      const entries = recentAudit(limit, {
        since: sinceIso,
        tool: req.query.tool as string | undefined,
        account: req.query.account as string | undefined,
        chain: req.query.chain as string | undefined,
        caller: callerFilter,
      });
      res.json({ ok: true, entries });
    }),
  );

  app.get(
    "/api/allowances",
    wrap(async (req, res) => {
      const wallet = await getContext(req.query.chain as string | undefined);
      const config = loadConfig();
      const profile = resolveProfile(wallet.chain, config);
      const { listAllowances } = await import("./approvals.js");
      const rows = await listAllowances(
        { publicClient: wallet.publicClient, profile, owner: wallet.account.address, logger },
        {},
      );
      res.json({
        ok: true,
        chain: wallet.chain,
        address: wallet.account.address,
        allowances: rows,
        // Iter248: timestamp parity. Allowances are a security-sensitive read —
        // operators monitoring "did we leave any standing approvals?" via a dashboard
        // poll need a clear freshness signal.
        timestamp: new Date().toISOString(),
      });
    }),
  );

  app.post(
    "/api/revoke",
    wrap(async (req, res) => {
      const body = req.body as { chain?: string; token: string; spender: string };
      if (!body.token || !body.spender) throw new ToolError("INVALID_PARAMS", "token + spender required");
      // Iter292: shared EIP-55 typo guard (was an inline copy of the CLI/MCP version
      // since iter257). One source of truth in chains.ts; same lowercase escape hatch.
      const { assertAddressEIP55 } = await import("./chains.js");
      assertAddressEIP55("spender", body.spender);
      const wallet = await getContext(body.chain);
      const config = loadConfig();
      const profile = resolveProfile(wallet.chain, config);
      // Iter254: actually resolve the token. Pre-iter254 the comment claimed "token
      // can be a symbol that resolveToken would normalize" — but the code cast token
      // straight to Address and passed it down. A POST with {token: "USDC"} flowed
      // "USDC" as if it were a contract address, blowing up later with a confusing
      // viem RPC error. CLI revoke has always called resolveToken first (cli/approvals.ts).
      // Now web does too.
      const tokenAddr = resolveToken(profile, body.token);
      if (!tokenAddr) throw unknownTokenError("token", body.token, profile);
      const { revokeToken } = await import("./approvals.js");
      const result = await auditWrap("revoke", body as unknown as Record<string, unknown>, wallet.chain, () =>
        revokeToken(
          { publicClient: wallet.publicClient, walletClient: wallet.walletClient, profile, logger, config },
          { token: tokenAddr, spender: body.spender as Address },
        ),
      );
      res.json({ ok: true, result });
    }),
  );

  // ── reconcile (Web parity with `tradekit reconcile` / MCP reconcile) ──
  // POST since it mutates DB rows (updates pending → success|failed). Returns the same
  // ReconcileReport shape the CLI prints, so the frontend can display the result inline.
  app.post(
    "/api/reconcile",
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { reconcilePending } = await import("./reconcile.js");
      const chain = typeof body.chain === "string" ? body.chain : undefined;
      // Iter287: same chain-filter validation as CLI/MCP (assertKnownChain).
      const config = loadConfig();
      const { assertKnownChain } = await import("./chains.js");
      assertKnownChain(chain, config);
      const report = await auditWrap("reconcile", body, chain, () =>
        reconcilePending({
          config,
          logger,
          chain,
          account: typeof body.account === "string" ? body.account : undefined,
        }),
      );
      res.json({ ok: true, report });
    }),
  );

  /**
   * Audit-wrap a write-flow web call. Mirrors mcp/runtime.ts runTool so web trades /
   * transfers / reconciles get the same audit_log treatment as CLI and MCP. Pre-iter201
   * web trades wrote to the trades table (via the underlying executeTrade) but NOT to
   * audit_log — leaving a compliance/observability gap where a wallet trader couldn't
   * see "who called what" via `tradekit audit` for web-initiated activity.
   */
  async function auditWrap<T>(
    tool: string,
    params: Record<string, unknown>,
    chain: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = new Date().toISOString();
    // Same shape as MCP runTool: redact sensitive params, cap size.
    const paramsJson = capAuditParams(JSON.stringify(redactSensitiveFields(params)));
    // Iter502: activeWalletLabel gate matches loadWallet (orphan-accounts case).
    const account = (params.account as string | undefined) ?? activeWalletLabel();
    // Iter398: dot-concat the action sub-field to match CLI iter342 + MCP iter397.
    // Same `.action` / `.direction` discriminator picking as runtime.ts. Pre-iter398
    // web rows had tool="config" while CLI had tool="config.set" — cross-surface
    // queries missed web. Web also previously logged trades as bare "buy"/"sell"
    // (per the iter pre-iter397 mistaken claim that "matches MCP convention");
    // that comment is no longer true, so the new dot-concat aligns all three surfaces.
    const subAction = (typeof params.action === "string" && params.action)
      || (typeof params.direction === "string" && params.direction)
      || null;
    const auditTool = subAction ? `${tool}.${subAction}` : tool;
    const safeAudit = (row: Parameters<typeof insertAudit>[0]) => {
      try {
        insertAudit(row);
      } catch (e) {
        // Iter476: sanitize before logging (iter474 helper) — sqlite errors
        // are typically one-line but the helper is cheap defense-in-depth.
        logger.error(sanitizeForLogLine(`audit write failed for ${tool}: ${(e as Error).message}`));
      }
    };
    try {
      const result = await fn();
      let tx_hash: string | null = null;
      if (result && typeof result === "object" && "txHash" in result) {
        const v = (result as Record<string, unknown>).txHash;
        if (typeof v === "string") tx_hash = v;
      }
      safeAudit({
        timestamp: start,
        caller: "web",
        tool: auditTool,
        account,
        chain: chain ?? null,
        params_json: paramsJson,
        simulation_json: null,
        result: "ok",
        error_code: null,
        error_message: null,
        tx_hash,
      });
      return result;
    } catch (e) {
      const te = toToolError(e);
      safeAudit({
        timestamp: start,
        caller: "web",
        tool: auditTool,
        account,
        chain: chain ?? null,
        params_json: paramsJson,
        simulation_json: null,
        result: "err",
        error_code: te.code,
        error_message: te.message,
        tx_hash: null,
      });
      throw te;
    }
  }

  /**
   * Validate-and-normalize a trade-amount field from the request body. Accepts:
   *   - undefined / null → undefined (the caller may legitimately omit one side)
   *   - "max" (any casing) → "max" (resolved later by trade.ts)
   *   - string → must parse as a positive finite decimal number; passed through verbatim
   *   - number → converted to string IF representable without scientific notation;
   *     rejected otherwise (Number.toString of very-small floats produces "5e-7" which
   *     viem's parseUnits cannot parse — the caller should pass strings to retain
   *     decimal precision).
   *
   * Iter253: extracted from the inline `body.X as string | undefined` casts that did no
   * runtime check. Number coercion via `String(0.1 + 0.2)` produces "0.30000000000000004",
   * a known floating-point pitfall; we don't want callers to silently lose precision.
   */
  function normalizeAmount(raw: unknown, fieldName: string): string | undefined {
    if (raw == null) return undefined;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return undefined;
      if (trimmed.toLowerCase() === "max") return trimmed;
      // Decimal-string check: digits, optional single decimal point. Reject scientific
      // notation, hex, etc. — these would parse via parseFloat but lose round-trip safety.
      if (!/^\d+(\.\d+)?$/.test(trimmed)) {
        throw new ToolError("INVALID_PARAMS", `${fieldName} must be a decimal string or "max" (got ${JSON.stringify(raw)}).`);
      }
      return trimmed;
    }
    if (typeof raw === "number") {
      if (!Number.isFinite(raw) || raw <= 0) {
        throw new ToolError("INVALID_PARAMS", `${fieldName} must be a positive number or decimal string (got ${JSON.stringify(raw)}).`);
      }
      const str = String(raw);
      // Reject scientific-notation rendering (5e-7) — viem's parseUnits won't parse it.
      // Caller should pass the value as a string to retain precision.
      if (str.includes("e") || str.includes("E")) {
        throw new ToolError(
          "INVALID_PARAMS",
          `${fieldName} value ${raw} can't be safely converted (renders as "${str}"). Pass as a decimal string instead, e.g. "0.0000005".`,
        );
      }
      return str;
    }
    throw new ToolError("INVALID_PARAMS", `${fieldName} must be a decimal string or "max" (got ${typeof raw}).`);
  }

  /** Shared body→TradeRequest mapper for /api/quote and /api/trade. */
  async function buildTradeReq(body: Record<string, unknown>, simulate: boolean) {
    const config = loadConfig();
    const wallet = await getContext(typeof body.chain === "string" ? body.chain : undefined);
    const profile = resolveProfile(wallet.chain, config);
    const { base, quote } = resolveTradePair(
      profile,
      (body.base as string) ?? "ETH",
      (body.quote as string) ?? "USDC",
    );
    // Iter251: validate direction + infer from amount when omitted, matching the MCP
    // quote tool's behavior. Pre-iter251 the web cast body.direction to "buy" | "sell"
    // with no runtime check; an invalid value like "swap" or undefined silently
    // became "sell" because executeTrade's branch is `if (req.direction === "buy") {
    // ... } else { /* sell path */ }`. A user posting {direction: "swap", baseAmount: 1}
    // got a sell when they intended... well, presumably the agent had a bug, but the
    // silent re-interpretation hid it.
    const rawDirection = body.direction;
    // Iter253: normalize amounts to string at the boundary. Pre-iter253 a JSON-posted
    // number like {baseAmount: 0.001} cast to string at the type level but stayed a
    // number at runtime; viem's parseUnits(value: string, decimals) would either
    // coerce via toString() (loses precision for floats — 0.1+0.2 → "0.30000000000000004")
    // or throw a confusing error several hops later. Strings only.
    const baseAmount = normalizeAmount(body.baseAmount, "baseAmount");
    const quoteAmount = normalizeAmount(body.quoteAmount, "quoteAmount");
    let direction: "buy" | "sell";
    if (rawDirection === "buy" || rawDirection === "sell") {
      direction = rawDirection;
    } else if (rawDirection != null) {
      throw new ToolError("INVALID_PARAMS", `direction must be "buy" or "sell" (got ${JSON.stringify(rawDirection)}).`);
    } else if (quoteAmount && !baseAmount) {
      direction = "buy";
    } else if (baseAmount && !quoteAmount) {
      direction = "sell";
    } else {
      throw new ToolError("INVALID_PARAMS", "Specify direction, or exactly one of baseAmount/quoteAmount.");
    }
    // Iter252: validate slippageBps to match MCP's zod schema. Pre-iter252 the value
    // was cast `as number | undefined` with no runtime check — a string "50" or a
    // float 50.5 flowed downstream and produced BigInt() throws or NaN math several
    // hops away. Now we reject at the boundary with a clear message.
    let slippageBps: number | undefined;
    if (body.slippageBps != null) {
      const raw = body.slippageBps;
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 5000) {
        throw new ToolError(
          "INVALID_PARAMS",
          `slippageBps must be an integer in [1, 5000] (got ${JSON.stringify(raw)}).`,
        );
      }
      slippageBps = n;
    }
    const req: TradeRequest = {
      direction,
      base,
      quote,
      baseAmount,
      quoteAmount,
      slippageBps,
      simulate,
      note: typeof body.note === "string" ? body.note : undefined,
    };
    return { wallet, profile, config, req };
  }

  app.post(
    "/api/quote",
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { wallet, profile, config, req: tradeReq } = await buildTradeReq(body, true);
      const result = await auditWrap("quote", body, wallet.chain, () =>
        executeTrade(tradeReq, {
          publicClient: wallet.publicClient,
          walletClient: wallet.walletClient,
          profile,
          config,
          logger,
          accountLabel: wallet.label,
        }),
      );
      res.json({ ok: true, result });
    }),
  );

  app.post(
    "/api/trade",
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { wallet, profile, config, req: tradeReq } = await buildTradeReq(
        body,
        Boolean(body.simulate),
      );
      // Iter398: tool is "trade" — auditWrap appends ".buy" or ".sell" from the
      // body.direction sub-field, producing audit row tool="trade.buy" / "trade.sell"
      // matching CLI iter342 + MCP iter397. Pre-iter398 web logged trades as bare
      // "buy" / "sell" with a comment claiming MCP convention — that's no longer true
      // (MCP iter397 also dot-concats now). All three surfaces now share vocabulary.
      // Make sure body has direction populated for the sub-action concat.
      const direction = tradeReq.direction === "buy" ? "buy" : "sell";
      const result = await auditWrap("trade", { ...body, direction }, wallet.chain, () =>
        executeTrade(tradeReq, {
          publicClient: wallet.publicClient,
          walletClient: wallet.walletClient,
          profile,
          config,
          logger,
          accountLabel: wallet.label,
        }),
      );
      res.json({ ok: true, result });
    }),
  );

  app.get(
    "/api/price",
    wrap(async (req, res) => {
      const tokenInput = req.query.token as string | undefined;
      if (!tokenInput) throw new ToolError("INVALID_PARAMS", "token is required");
      // Iter240: resolve symbols ("ETH", "USDC", …) against the active chain profile,
      // matching the CLI's `tradekit price ETH` ergonomic. Pre-iter240 only raw 0x
      // addresses worked — passing `?token=ETH` silently returned price=null because
      // getCurrentPrice forwarded "ETH" to CoinGecko/DexScreener as if it were an
      // address. The `chain` query lets a caller override (e.g. price an arbitrum
      // token from a base-active session).
      const config = loadConfig();
      const chainName = (req.query.chain as string) ?? config.activeChain;
      const profile = resolveProfile(chainName, config);
      const resolved = resolveToken(profile, tokenInput);
      if (!resolved) throw unknownTokenError("token", tokenInput, profile);
      const price = await getCurrentPrice(resolved, logger);
      res.json({
        ok: true,
        token: resolved,
        chain: chainName,
        price,
        // Same response-envelope timestamp as the CLI/MCP price tools (iter238). Lets a
        // dashboard polling /api/price reason about cache staleness.
        timestamp: new Date().toISOString(),
      });
    }),
  );

  app.get(
    "/api/candles",
    wrap(async (req, res) => {
      const symbol = (req.query.instId as string) ?? "ETH-USDT";
      const bar = (req.query.bar as string) ?? "1H";
      const limit = (req.query.limit as string) ?? "200";
      const okxUrl = `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=${encodeURIComponent(bar)}&limit=${encodeURIComponent(limit)}`;
      const r = await fetchWithTimeout(okxUrl);
      // Two failure modes worth surfacing instead of forwarding as if successful:
      //   1. HTTP non-2xx (rate limit, 5xx) — the chart would render garbage.
      //   2. OKX returns 200 but with code !== "0" and an explanatory msg (e.g. unknown
      //      instId, rate-limited). That's a logical failure even though HTTP says 200.
      // Both surface as 502 Bad Gateway with the upstream's own message preserved.
      if (!r.ok) {
        res.status(502).json({
          ok: false,
          error: { code: "API_ERROR", message: `OKX ${r.status} ${r.statusText}` },
        });
        return;
      }
      const body = (await r.json()) as { code?: string; msg?: string; data?: unknown };
      if (body.code !== undefined && body.code !== "0") {
        res.status(502).json({
          ok: false,
          error: { code: "API_ERROR", message: `OKX: ${body.msg || "code=" + body.code}` },
        });
        return;
      }
      // Iter888: ok:true envelope for symmetry with the failure path above and
      // every other /api/* success response. Pure additive — Chart.tsx reads
      // `body.data ?? []` which still works since `data` is at top level
      // after the spread.
      res.json({ ok: true, ...body });
    }),
  );

  app.get(
    "/api/trending",
    wrap(async (req, res) => {
      const q = req.query.q as string | undefined;
      const chain = (req.query.chain as string | undefined) ?? loadConfig().activeChain;
      const limit = parseQueryInt(req.query.limit, "limit", { min: 1, max: 100, defaultValue: 10 });
      const pairs = q ? await searchToken(q, logger) : await trendingOnChain(chain, logger, limit);
      // Iter422: parity with the CLI's iter422 envelope shape — same {ok, query, chain,
      // pairs, timestamp} contract so a script consuming both surfaces gets identical
      // structure. `query` is null when listing trending-on-chain (no search term).
      res.json({ ok: true, query: q ?? null, chain, pairs, timestamp: new Date().toISOString() });
    }),
  );

  // ── automation API (read-only) ──────────────────────────────
  // Orders / schedules / rebalance (+ decision-journal tails),
  // playbooks, paper book, unified timeline, alerts, strategy
  // reports. Registered AFTER authMiddleware so the routes inherit
  // the same token gate; zero RPC, zero writes — see webAutomation.ts.
  registerAutomationRoutes(app);

  // ── static React bundle (SPA fallback to index.html for client routes) ──
  const bundleDir = resolveBundledWebui();
  if (bundleDir) {
    app.use(express.static(bundleDir, { index: "index.html", maxAge: "5m" }));
    // SPA fallback: any unmatched GET that's not /api/* serves index.html
    app.get(/^(?!\/api\/).+/, (_req, res) => {
      res.sendFile(join(bundleDir, "index.html"));
    });
  } else {
    logger.warn(`Web bundle not found — run \`pnpm -C webui build\` to build the React UI.`);
    app.get("/", (_req, res) => {
      res
        .status(503)
        .type("html")
        .send(
          `<html><body style="font-family:ui-monospace,monospace;background:#0e1116;color:#e6edf3;padding:30px">` +
            `<h2>Web bundle not built</h2>` +
            `<p>Run <code>pnpm -C webui build</code> then restart <code>tradekit web</code>.</p>` +
            `</body></html>`,
        );
    });
  }

  // Catch-all 404 for /api/* paths. Pre-iter147 a typo'd endpoint like /api/whops fell
  // through every route and produced Express's default HTML 404 — confusing for any
  // client expecting JSON, and the agent's auto-parser would throw on the html. Return
  // a structured ToolError JSON so the frontend / MCP-via-web client gets a clean shape.
  app.use("/api", (req, res) => {
    res.status(404).json({
      ok: false,
      error: {
        code: "INVALID_PARAMS",
        message: `No such API endpoint: ${req.method} ${req.path}`,
      },
    });
  });

  // ── error middleware ────────────────────────────────────────
  // Must be last. Translates ToolError / unknown errors to a structured JSON response,
  // with HTTP status mapped from the error code so the frontend can branch on category
  // (401 re-auth, 5xx retry, 4xx surface to user) without parsing the body.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const te = toToolError(err);
    // Iter444: include method + path in the log line so server.log is searchable by
    // failing endpoint. Pre-iter444 the log just said "web RPC_FAILED: ..." with no
    // way to tell whether /api/trade or /api/trending hit the error — same code +
    // message could come from either, and a grep had to fall back to timestamp matching
    // against access logs. method + path are both already known to express in this
    // middleware; surfacing them is free.
    // Iter463 + iter473: cap + sanitize te.message via the shared helper so the
    // server.log line stays single-line and bounded at 500 chars. Full message
    // still goes to the client via te.toJSON(). Iter474 extracted the formula
    // into logger.sanitizeForLogLine for unit-test coverage.
    const truncatedMsg = sanitizeForLogLine(te.message);
    logger.error(`web ${req.method} ${req.path} → ${te.code}: ${truncatedMsg}`);
    res.status(httpStatusForCode(te.code)).json(te.toJSON());
  });

  // ── listen + graceful shutdown ──────────────────────────────
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(opts.port, opts.host, () => {
      const url = `http://${opts.host}:${opts.port}/?token=${token}`;
      logger.info(`Web server listening on http://${opts.host}:${opts.port}`);
      console.log("");
      // Print URL on its own bare line so triple-click + copy gets just the URL.
      // The boxed banner that follows is visual decoration only; box chars and the
      // trailing token would contaminate a paste otherwise. Pre-iter175 the only
      // copy-friendly form was hidden inside the boxed line.
      console.log(`  ${url}`);
      console.log("");
      console.log("┌─ tradekit web ──────────────────────────────────────────────────────────┐");
      console.log("│                                                                         │");
      console.log("│  ⚠  Anyone with the URL above can trade from your wallet. Keep secret. │");
      // Iter392: acknowledge when the token was pinned via env so the banner doesn't
      // suggest the operator do something they've already done. Pre-iter392 the line
      // always said "Override with TRADEKIT_WEB_TOKEN env to pin..." regardless of
      // whether the operator already had — a small honesty/accuracy fix matching the
      // iter312/iter327 "report what actually happened" discipline.
      if (process.env.TRADEKIT_WEB_TOKEN) {
        console.log("│     Token is pinned via TRADEKIT_WEB_TOKEN env — same URL across runs. │");
      } else {
        console.log("│     Override with TRADEKIT_WEB_TOKEN env to pin a token across runs.    │");
      }
      console.log("└─────────────────────────────────────────────────────────────────────────┘");
      console.log("");
      resolve();
    });
    // Without this listener, `listen` errors (port-in-use, permission-denied, invalid
    // host) crash the process with an uncaught-exception stack trace. Surface them as
    // a clean ToolError so the same toToolError → friendly-message flow that handles
    // every other failure also covers startup.
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new ToolError(
            "INTERNAL_ERROR",
            `Port ${opts.port} on ${opts.host} is already in use. Stop the other process or pick a different --port.`,
            { details: { host: opts.host, port: opts.port, syscall: err.syscall } },
          ),
        );
      } else if (err.code === "EACCES") {
        reject(
          new ToolError(
            "INTERNAL_ERROR",
            `Permission denied to bind ${opts.host}:${opts.port}. Use a port ≥ 1024 or run with elevated privileges.`,
            { details: { host: opts.host, port: opts.port } },
          ),
        );
      } else if (err.code === "EADDRNOTAVAIL") {
        reject(
          new ToolError(
            "INTERNAL_ERROR",
            `Host ${opts.host} isn't available on this machine. Use 127.0.0.1 for local-only, or a real interface IP.`,
            { details: { host: opts.host, port: opts.port } },
          ),
        );
      } else {
        reject(err);
      }
    });
    const shutdown = (signal: string) => {
      logger.info(`Received ${signal}, shutting down web server`);
      server.close(() => {
        try { closeDb(); } catch { /* ignore */ }
        logger.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}
