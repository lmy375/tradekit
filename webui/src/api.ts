// Thin fetch wrappers. The auth token rides on the tk_token cookie set by the bootstrap
// GET /?token=… handler, so subsequent calls don't need to thread it manually. The dev
// server's vite.config.ts proxies /api → http://127.0.0.1:3030 so HMR works.

export type Json = unknown;

async function call<T = Json>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  const body = (await r.json()) as Record<string, unknown>;
  if (!r.ok || body.ok === false) {
    const err = (body.error as { code?: string; message?: string }) ?? {};
    throw Object.assign(new Error(err.message ?? `HTTP ${r.status}`), { code: err.code, body });
  }
  return body as T;
}

export const api = {
  get: <T = Json>(path: string) => call<T>(path),
  post: <T = Json>(path: string, body: unknown) =>
    call<T>(path, { method: "POST", body: JSON.stringify(body) }),
};

// ── typed convenience methods for the pages ─────────────────

export interface StatusResp {
  ok: true;
  address: string | null;
  activeAccount: string;
  activeChain: string;
  accounts: { label: string; index: number; address: string }[];
  chains: string[];
}
export const getStatus = () => api.get<StatusResp>("/api/status");

/** Shared props for every page component. */
export interface PageProps {
  status: StatusResp;
  /** Re-fetch /api/status after a mutating call (chain/account switch, etc.). */
  onStatusChange?: () => void;
}

export interface HoldingsReport {
  chain: string;
  chainId: number;
  address: string;
  totalUsd?: number;
  balances: { symbol: string; amount: string; usd?: number; token: string | "NATIVE" }[];
}
export const getHoldings = (params?: { address?: string; chains?: string[] }) => {
  const qs = new URLSearchParams();
  if (params?.address) qs.set("address", params.address);
  if (params?.chains?.length) qs.set("chains", params.chains.join(","));
  return api.get<{ ok: true; reports: HoldingsReport[] }>(`/api/holdings?${qs}`);
};

export interface TradeRow {
  id: number;
  timestamp: string;
  chain: string;
  account: string;
  direction: "buy" | "sell";
  base_symbol: string | null;
  base_amount: string;
  quote_symbol: string | null;
  quote_amount: string;
  price: string;
  tx_hash: string;
  status: string;
  aggregator: string | null;
  notes: string | null;
}
export const getTrades = (
  params: {
    limit?: number;
    chain?: string;
    account?: string;
    /** Filter to a single status. */
    status?: "success" | "failed" | "pending";
    /** Filter to rows where this symbol/address appears as base or quote. */
    token?: string;
    /** Case-insensitive substring match against the trade's notes column. */
    note?: string;
  } = {},
) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, String(v));
  return api.get<{ ok: true; trades: TradeRow[] }>(`/api/trades?${qs}`);
};

export interface PnLReport {
  account: string;
  totalRealizedUsd: number;
  totalUnrealizedUsd: number;
  totalGasUsd: number;
  totalRealizedAfterGasUsd: number;
  positions: {
    chain: string;
    symbol: string;
    amount: string;
    avgCostUsd: number;
    realizedUsd: number;
    currentPriceUsd?: number;
    unrealizedUsd?: number;
    trades: number;
  }[];
  gas: { chain: string; amount: string; usd?: number }[];
}
export const getPnL = () => api.get<{ ok: true; report: PnLReport }>("/api/pnl");

export interface ReconcileReport {
  scanned: number;
  resolvedSuccess: number;
  resolvedFailed: number;
  stillPending: number;
  errors: { txHash: string; message: string }[];
}
export const postReconcile = (opts: { chain?: string; account?: string } = {}) =>
  api.post<{ ok: true; report: ReconcileReport }>("/api/reconcile", opts);

export interface ApprovalRow {
  token: string;
  symbol: string;
  spender: string;
  spenderLabel?: string;
  display: string;
  allowance: string;
}
export const getAllowances = (chain?: string) => {
  const qs = chain ? `?chain=${chain}` : "";
  return api.get<{ ok: true; chain: string; address: string; allowances: ApprovalRow[] }>(
    `/api/allowances${qs}`,
  );
};
export const postRevoke = (token: string, spender: string, chain?: string) =>
  api.post<{ ok: true }>("/api/revoke", { token, spender, chain });

export interface AuditRow {
  id: number;
  timestamp: string;
  caller: string | null;
  tool: string;
  account: string | null;
  chain: string | null;
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  tx_hash: string | null;
}
export const getAudit = (
  opts: {
    limit?: number;
    /** ISO date or full timestamp; only entries at/after this. */
    since?: string;
    /** Filter to a single tool name. */
    tool?: string;
    /** Filter to a single account label. */
    account?: string;
    /** Filter to a single chain. */
    chain?: string;
  } = {},
) => {
  const qs = new URLSearchParams();
  qs.set("limit", String(opts.limit ?? 100));
  if (opts.since) qs.set("since", opts.since);
  if (opts.tool) qs.set("tool", opts.tool);
  if (opts.account) qs.set("account", opts.account);
  if (opts.chain) qs.set("chain", opts.chain);
  return api.get<{ ok: true; entries: AuditRow[] }>(`/api/audit?${qs}`);
};

export interface ConfigShape {
  activeChain: string;
  activeAccount: string;
  defaultSlippageBps: number;
  chains: Record<string, unknown>;
  aggregator: { preferred: string[]; apiKeys?: Record<string, string> };
  safety: Record<string, unknown>;
}
export const getConfig = () => api.get<{ ok: true; config: ConfigShape }>("/api/config");
export const postConfig = (path: string, value: unknown) =>
  api.post<{ ok: true; config: ConfigShape }>("/api/config", { path, value });

export interface QuoteResult {
  ok: boolean;
  simulated: boolean;
  direction: "buy" | "sell";
  baseSymbol?: string;
  baseAmount: string;
  quoteSymbol?: string;
  quoteAmount: string;
  price: string;
  estimatedUsd?: number;
  balanceFraction?: number;
  aggregator: string;
  allowanceTarget: string;
  to: string;
  txHash?: string;
  status?: string;
  simulation?: { ok: boolean; gas: string; gasCostNative: string; revertReason?: string };
}
export const postQuote = (body: Record<string, unknown>) =>
  api.post<{ ok: true; result: QuoteResult }>("/api/quote", body);
export const postTrade = (body: Record<string, unknown>) =>
  api.post<{ ok: true; result: QuoteResult }>("/api/trade", body);
