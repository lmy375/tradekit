import { existsSync, readFileSync } from "fs";
import { writeFileSecure, chmodSecureIfExists, ensureDataDir } from "./secureIo.js";
import { create, decrypt, privateKeyToAccount as web3PrivateKeyToAccount } from "web3-eth-accounts";
import {
  createPublicClient,
  createWalletClient,
  type PublicClient,
  type WalletClient,
  type Account,
  type Transport,
  type Chain,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DATA_DIR, WALLET_PATH, MNEMONIC_PATH, KEYSTORE_LABEL } from "./constants.js";
import { makeTransport, type ChainProfile } from "./chains.js";
import { buildSubmitTransport } from "./mev.js";
import { loadConfig } from "./config.js";
import {
  loadAccountsFile,
  activeAccountEntry,
  deriveAccount,
  unknownAccountError,
  type AccountEntry,
} from "./accounts.js";
import type { Logger } from "./logger.js";
import { ToolError, wrongPasswordError } from "./errors.js";
import { acquireLock } from "./processLock.js";

export interface WalletContext {
  account: Account;
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
  /** Label of the active account (HD) or "keystore" for single-key. */
  label: string;
}

// ── single-key keystore (unchanged web3-eth-accounts format) ─

export async function createWallet(pass: string, logger: Logger): Promise<Address> {
  // Iter611: same wallet-mutation lock as the HD entry points in accounts.ts.
  // Without it, concurrent `wallet create` calls could both produce keystores
  // and the second writer's tempfile rename would clobber the first.
  ensureDataDir(DATA_DIR);
  const lock = acquireLock(DATA_DIR, "wallet", "createWallet");
  try {
    const newAccount = create();
    const keystore = await newAccount.encrypt(pass);
    writeFileSecure(WALLET_PATH, JSON.stringify(keystore, null, 2));
    logger.info("Wallet saved to " + WALLET_PATH);
    const account = privateKeyToAccount(newAccount.privateKey as `0x${string}`);
    return account.address;
  } finally {
    lock.release();
  }
}

export async function importWallet(privateKey: string, pass: string, logger: Logger): Promise<Address> {
  ensureDataDir(DATA_DIR);
  const lock = acquireLock(DATA_DIR, "wallet", "importWallet");
  try {
    const normalized = normalizePrivateKey(privateKey);
    const account = privateKeyToAccount(normalized);
    const web3Account = web3PrivateKeyToAccount(normalized);
    const keystore = await web3Account.encrypt(pass);
    writeFileSecure(WALLET_PATH, JSON.stringify(keystore, null, 2));
    logger.info("Wallet saved to " + WALLET_PATH);
    return account.address;
  } finally {
    lock.release();
  }
}

/**
 * Validate + normalize a private-key CLI input. Accepts the canonical 0x-prefixed
 * 64-hex form AND the bare 64-hex form (some block explorers / hardware wallet
 * exports omit the prefix). Trims surrounding whitespace and rejects everything
 * else with a clear INVALID_PARAMS — pre-iter138 a typo or wrong-length input
 * produced an opaque viem error from inside privateKeyToAccount.
 *
 * Returned as a typed `0x${string}` so the call site no longer needs the `as` cast.
 *
 * SECURITY NOTE: this function returns the key. Don't log it. Don't pass it to
 * audit_log (the wallet password redaction in db.ts handles "private-key" etc.,
 * but the raw private key arg should never reach the audit layer in the first
 * place — only the keystore-encrypted form should ever be persisted).
 */
export function normalizePrivateKey(raw: string): `0x${string}` {
  const trimmed = raw.trim();
  // Drop optional 0x prefix for the validation step, but normalize OUTPUT to 0x form.
  const bare = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Invalid private key — expected 64 hex chars (optionally 0x-prefixed), got ${bare.length} chars.`,
      { details: { providedLength: bare.length, expectedLength: 64, reason: "invalid_private_key_format" } },
    );
  }
  return `0x${bare.toLowerCase()}` as `0x${string}`;
}

/**
 * Read + JSON-parse the single-key keystore. Surfaces a corruption message that
 * distinguishes "you don't have a keystore" from "your keystore is unreadable" so
 * the operator goes to backup instead of thinking they need to re-create the wallet.
 * Same pattern as iter180/181 for accounts.json / mnemonic.json.
 */
function readKeystore(): unknown {
  const raw = readFileSync(WALLET_PATH, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ToolError(
      "INTERNAL_ERROR",
      `${WALLET_PATH} is corrupted and cannot be parsed (${(e as Error).message}). Your encrypted keystore is unreadable — the only recovery is restoring the file from backup OR re-importing the private key via 'tradekit wallet import'.`,
      { details: { path: WALLET_PATH, reason: "corrupted", severity: "catastrophic" } },
    );
  }
}

export async function exportWallet(pass: string, logger: Logger): Promise<string> {
  if (!existsSync(WALLET_PATH)) {
    // Distinguish between "no wallet at all" and "you have HD, this command only
    // exports the single-key keystore." Pre-iter184 both produced the same message,
    // leaving HD users wondering why their wallet "isn't found".
    if (existsSync(MNEMONIC_PATH)) {
      throw new ToolError(
        "WALLET_NOT_FOUND",
        `No single-key keystore at ${WALLET_PATH}. You have an HD mnemonic wallet — 'wallet export' only handles single-key keystores (created via 'wallet create' / 'wallet import'). To get a per-account private key for an HD account, derive it externally from your mnemonic.`,
        { details: { path: WALLET_PATH, reason: "hd_only_wallet", hint: "use_external_derivation_from_mnemonic" } },
      );
    }
    throw new ToolError(
      "WALLET_NOT_FOUND",
      "No single-key wallet found. Run `tradekit wallet create` (new) or `tradekit wallet import` (existing private key) first.",
      { details: { path: WALLET_PATH, reason: "no_wallet" } },
    );
  }
  const keystore = readKeystore();
  const decrypted = await decrypt(keystore as never, pass).catch(() => {
    throw wrongPasswordError("keystore");
  });
  logger.info("Wallet decrypted successfully");
  return decrypted.privateKey;
}

/** Address from the single-key keystore (no password needed). */
export function getKeystoreAddress(): Address | null {
  if (!existsSync(WALLET_PATH)) return null;
  try {
    const keystoreJson = readFileSync(WALLET_PATH, "utf-8");
    const keystore = JSON.parse(keystoreJson);
    if (keystore.address) {
      const addr = keystore.address.startsWith("0x") ? keystore.address : `0x${keystore.address}`;
      return addr as Address;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Iter516: shared gate for activeWalletAddress + activeWalletLabel — they each used
 * the same `existsSync(MNEMONIC_PATH) ? activeAccountEntry() : null` check, drifting
 * apart would be a real bug (the iter499-502 arc was exactly that class of drift).
 * Returns the active HD entry only when BOTH accounts.json AND mnemonic.json exist,
 * matching what loadWallet would actually use for signing.
 */
function activeHdEntry(): AccountEntry | null {
  if (!existsSync(MNEMONIC_PATH)) return null;
  return activeAccountEntry();
}

/**
 * Returns the currently-active address: prefers HD active account when BOTH accounts.json
 * AND mnemonic.json exist, otherwise falls back to the single-key keystore.
 *
 * Iter499: the HD gate mirrors loadWallet / loadReadOnlyWallet (`accountsFile &&
 * existsSync(MNEMONIC_PATH)`). Pre-iter499 the gate was just "accountsFile exists"
 * — so an orphaned accounts.json (mnemonic deleted by panic-cleanup, bad backup
 * restore, etc.) leaked an HD address that loadWallet couldn't actually derive. The
 * doctor command surfaced the HD address; the trade flow loaded the keystore; the
 * two views of "active wallet" disagreed. Now both paths agree.
 */
export function activeWalletAddress(): Address | null {
  return activeHdEntry()?.address ?? getKeystoreAddress();
}

/**
 * Returns the active wallet's LABEL — "alice" / "default" / etc for HD, "keystore"
 * for single-key. Same gate as activeWalletAddress (iter499): HD only "wins" when
 * BOTH accounts.json and mnemonic.json exist. Matches what loadWallet would set as
 * `wallet.label` for the same machine state, so audit attribution stays consistent
 * with the actual key used by trade / transfer / approve flows.
 *
 * Iter500: pre-iter500 callers re-implemented the fallback inline
 * (`activeAccountEntry()?.label ?? "keystore"`) — which diverged from loadWallet
 * in the orphan-accounts case (iter499 fixed the matching divergence in
 * activeWalletAddress). Now there's a single source of truth.
 */
export function activeWalletLabel(): string {
  return activeHdEntry()?.label ?? KEYSTORE_LABEL;
}

/**
 * Build a WalletContext for read-only / simulate-only use — does NOT decrypt the
 * keystore, does NOT require a password. The returned walletClient has `account.address`
 * set (so eth_call's `from` works) but no signing key; any send/write call would fail.
 *
 * Use this for `tradekit quote …` and other dry-run paths where we need the active
 * address as the simulation `from` but never actually sign. Reads accounts.json /
 * wallet.json for the active address — both files are unencrypted (the address is
 * public-derived, safe to read at rest).
 *
 * If `accountLabel` is set, looks up that HD account by label instead of the active one.
 */
export function loadReadOnlyWallet(
  profile: ChainProfile,
  extraRpcs: string[] = [],
  accountLabel?: string,
): WalletContext {
  let address: Address;
  let label: string;
  const accountsFile = loadAccountsFile();
  if (accountsFile && existsSync(MNEMONIC_PATH)) {
    const targetLabel = accountLabel ?? accountsFile.active;
    const target = accountsFile.accounts.find((a) => a.label === targetLabel);
    if (!target) {
      throw unknownAccountError(targetLabel, accountsFile.accounts.map((a) => a.label));
    }
    address = target.address as Address;
    label = target.label;
  } else {
    const keystoreAddr = getKeystoreAddress();
    if (!keystoreAddr) {
      throw new ToolError(
        "WALLET_NOT_FOUND",
        "No wallet found. Run `tradekit init` for a guided setup (or `tradekit wallet create` / `tradekit wallet import` / `tradekit account create-mnemonic` directly if you already know which wallet type you want).",
        { details: { reason: "no_wallet", checkedPaths: { keystore: WALLET_PATH, mnemonic: MNEMONIC_PATH } } },
      );
    }
    address = keystoreAddr;
    label = KEYSTORE_LABEL;
  }
  const transport = makeTransport(profile, extraRpcs);
  const publicClient = createPublicClient({
    chain: profile.viemChain,
    transport,
  }) as PublicClient<Transport, Chain>;
  // walletClient with just an address creates a viem JsonRpcAccount. Signing methods
  // (sendTransaction / writeContract) would delegate to the RPC — they fail by design
  // here, since our chosen RPCs are public and don't host keys. That's fine: we only
  // need `account.address` for eth_call's `from`. Callers MUST check `simulate=true`
  // before reaching any send path.
  //
  // MEV note: read-only wallets never submit (they exist for simulate/quote
  // paths) so the private-RPC routing is a no-op here. We still pass the
  // mev config through for shape uniformity with loadWallet — buildSubmitTransport
  // returns the unchanged public transport when mev is inactive.
  const submitTransport = buildSubmitTransport({
    profile,
    mev: loadConfig().mev,
    publicTransport: transport,
  });
  const walletClient = createWalletClient({
    account: address,
    chain: profile.viemChain,
    transport: submitTransport,
  }) as unknown as WalletClient<Transport, Chain, Account>;
  const account = walletClient.account as Account;
  return { account, publicClient, walletClient, label };
}

/**
 * Load the active wallet — HD if mnemonic + accounts.json present, otherwise single-key keystore.
 * The returned WalletContext uses a failover transport across the chain profile's RPCs.
 *
 * @param accountLabel  Optional per-call HD account override. When set, derives that account
 *                      instead of the one marked active in accounts.json. Only meaningful when
 *                      an HD mnemonic is configured; ignored for single-key keystore wallets.
 */
export async function loadWallet(
  pass: string,
  profile: ChainProfile,
  extraRpcs: string[] = [],
  logger?: Logger,
  accountLabel?: string,
): Promise<WalletContext> {
  let account: Account;
  let label: string;

  // Legacy installs created these files with default 0644 perms (world-readable —
  // enables offline brute-force on a weak password). On every load, promote both to
  // 0600 if they exist. Idempotent and silent on platforms that don't support it.
  chmodSecureIfExists(WALLET_PATH);
  chmodSecureIfExists(MNEMONIC_PATH);

  const accountsFile = loadAccountsFile();
  if (accountsFile && existsSync(MNEMONIC_PATH)) {
    const targetLabel = accountLabel ?? accountsFile.active;
    const target = accountsFile.accounts.find((a) => a.label === targetLabel);
    if (!target) {
      // Iter344: shared helper surfaces a "Did you mean" hint via closestMatch.
      throw unknownAccountError(targetLabel, accountsFile.accounts.map((a) => a.label));
    }
    account = deriveAccount(target.label, pass);
    label = target.label;
    logger?.info(`Loaded HD account "${label}" → ${account.address}`);
  } else if (existsSync(WALLET_PATH)) {
    const keystore = readKeystore();
    const decrypted = await decrypt(keystore as never, pass).catch(() => {
      throw wrongPasswordError("keystore");
    });
    account = privateKeyToAccount(decrypted.privateKey as `0x${string}`);
    label = KEYSTORE_LABEL;
    logger?.info(`Loaded single-key wallet → ${account.address}`);
  } else {
    throw new ToolError(
      "WALLET_NOT_FOUND",
      "No wallet found. Run `tradekit init` for a guided setup (or `tradekit wallet create` / `tradekit wallet import` / `tradekit account create-mnemonic` directly if you already know which wallet type you want).",
      { details: { reason: "no_wallet", checkedPaths: { keystore: WALLET_PATH, mnemonic: MNEMONIC_PATH } } },
    );
  }

  const transport = makeTransport(profile, extraRpcs);
  const publicClient = createPublicClient({
    chain: profile.viemChain,
    transport,
  }) as PublicClient<Transport, Chain>;
  // MEV-protected submission path: when config.mev is enabled AND the
  // chain has a privateRpcs[<chain>] entry, walletClient writes route
  // through the private relay. Reads (publicClient above) stay on the
  // public fallback chain — most private relays buffer txs for some
  // blocks before propagation, so reading a freshly-submitted private
  // tx via the same endpoint would hang waiting for inclusion.
  //
  // The builder is pure-pass-through when MEV isn't active for this
  // chain, so the no-MEV path is structurally identical to the pre-
  // MEV behavior.
  const submitTransport = buildSubmitTransport({
    profile,
    mev: loadConfig().mev,
    publicTransport: transport,
  });
  const walletClient = createWalletClient({
    account,
    chain: profile.viemChain,
    transport: submitTransport,
  }) as WalletClient<Transport, Chain, Account>;

  return { account, publicClient, walletClient, label };
}
