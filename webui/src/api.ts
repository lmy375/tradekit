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

// ── automation API (read-only; src/webAutomation.ts) ─────────

export interface EngineResp {
  ok: true;
  running: boolean;
  status: {
    pid: number;
    startedAt: string;
    updatedAt: string;
    stopping?: boolean;
    workers: { name: string; lastTickAt: string | null; ticks: number; failures: number }[];
  } | null;
  lock: { active: boolean; reason: string | null; lockedAt: string | null; lockedBy: string | null };
}
export const getEngine = () => api.get<EngineResp>("/api/engine");

export interface AutoOrderRow {
  id: number;
  status: string;
  side: string;
  trigger_type: string;
  target_price_usd: number | null;
  trail_pct: number | null;
  water_mark_usd: number | null;
  chain: string;
  account: string;
  base_symbol: string | null;
  quote_symbol: string | null;
  base_amount: string | null;
  quote_amount: string | null;
  strategy: string | null;
  paper: number;
  created_at: string;
  expires_at: string | null;
  on_fill_json: string | null;
}
export interface OrderJournalRow {
  checked_at: string;
  decision: string;
  price_usd: number | null;
  water_mark_usd: number | null;
  notes: string | null;
}
export const getAutoOrders = (status: string) =>
  api.get<{ ok: true; orders: AutoOrderRow[] }>(`/api/orders?status=${encodeURIComponent(status)}`);
export const getAutoOrderDetail = (id: number) =>
  api.get<{ ok: true; order: AutoOrderRow; journal: OrderJournalRow[] }>(`/api/orders/${id}`);

export interface AutoScheduleRow {
  id: number;
  status: string;
  name: string | null;
  side: string;
  cron_expr: string;
  next_run_at: string;
  run_count: number;
  max_runs: number | null;
  base_symbol: string | null;
  quote_symbol: string | null;
  base_amount: string | null;
  quote_amount: string | null;
  strategy: string | null;
  paper: number;
  last_run_at: string | null;
  last_run_status: string | null;
  on_fill_json: string | null;
}
export interface ScheduleJournalRow {
  checked_at: string;
  decision: string;
  run_number: number | null;
  tx_hash: string | null;
  error_code: string | null;
  notes: string | null;
}
export const getAutoSchedules = (status: string) =>
  api.get<{ ok: true; schedules: AutoScheduleRow[] }>(`/api/schedules?status=${encodeURIComponent(status)}`);
export const getAutoScheduleDetail = (id: number) =>
  api.get<{ ok: true; schedule: AutoScheduleRow; journal: ScheduleJournalRow[] }>(`/api/schedules/${id}`);

export interface AutoRebalanceRow {
  id: number;
  status: string;
  name: string | null;
  targets_json: string;
  drift_threshold_pct: number;
  min_trade_usd: number;
  next_run_at: string;
  run_count: number;
  strategy: string | null;
  paper: number;
  last_run_at: string | null;
  last_run_max_drift_pct: number | null;
}
export interface RebalanceJournalRow {
  checked_at: string;
  decision: string;
  max_drift_pct: number | null;
  threshold_pct: number | null;
  executed_count: number | null;
  skipped_count: number | null;
  error_code: string | null;
}
export const getAutoRebalance = (status: string) =>
  api.get<{ ok: true; plans: AutoRebalanceRow[] }>(`/api/rebalance?status=${encodeURIComponent(status)}`);
export const getAutoRebalanceDetail = (id: number) =>
  api.get<{ ok: true; plan: AutoRebalanceRow; journal: RebalanceJournalRow[] }>(`/api/rebalance/${id}`);

export interface AutoPlaybookRow {
  id: number;
  name: string;
  status: string;
  deployed_at: string | null;
}
export const getAutoPlaybooks = () => api.get<{ ok: true; playbooks: AutoPlaybookRow[] }>("/api/playbooks");

export interface AlertsResp {
  ok: true;
  active: { tag: string; rule_type: string; first_triggered_at: string | null }[];
  history: { at: string; tag: string; rule_type: string; event: string; severity: string }[];
}
export const getAlerts = () => api.get<AlertsResp>("/api/alerts?limit=10");

export interface PaperResp {
  ok: true;
  balances: { account: string; chain: string; token: string; balance: string }[];
  pnl: { strategy: string; fills: number; netQuote: number }[];
}
export const getPaper = () => api.get<PaperResp>("/api/paper");

// ── timeline (forensic event stream) ─────────────────────────

export type TimelineSeverity = "info" | "warn" | "critical";

export interface TimelineEventRow {
  at: string;
  kind: string;
  severity: TimelineSeverity;
  summary: string;
  refs: { type: string; id: number | string; txHash?: string; strategy?: string };
  details?: Record<string, string | number | boolean | null>;
}

export interface TimelineQuery {
  since?: string;       // duration shorthand ("6h", "2d") or ISO
  kinds?: string[];     // omit for all
  minSeverity?: TimelineSeverity;
  strategy?: string;
  limit?: number;
}

export const getTimeline = (q: TimelineQuery) => {
  const qs = new URLSearchParams();
  if (q.since) qs.set("since", q.since);
  if (q.kinds && q.kinds.length > 0) qs.set("kinds", q.kinds.join(","));
  if (q.minSeverity) qs.set("minSeverity", q.minSeverity);
  if (q.strategy) qs.set("strategy", q.strategy);
  if (q.limit) qs.set("limit", String(q.limit));
  return api.get<{ ok: true; count: number; events: TimelineEventRow[] }>(`/api/timeline?${qs}`);
};

// ── funding runway ───────────────────────────────────────────

export interface RunwayBucket {
  account: string;
  chain: string;
  paper: boolean;
  token: string;
  symbol: string | null;
  balance: number | null;
  oneShotReserved: number;
  burn30d: number;
  totalFiresInHorizon: number;
  firesCovered: number;
  exhaustsAt: string | null;
  runwayDays: number | null;
}

export interface GasRunwayRow {
  account: string;
  chain: string;
  balance: number | null;
  avgGasPerFire: number | null;
  gasSamples: number;
  totalFiresInHorizon: number;
  oneShotOrders: number;
  firesCovered: number;
  exhaustsAt: string | null;
  runwayDays: number | null;
}

export interface RunwayResp {
  ok: true;
  generatedAt: string;
  horizonDays: number;
  buckets: RunwayBucket[];
  gas: GasRunwayRow[];
  skipped: { kind: string; id: number; reason: string }[];
}

export const getRunway = (days = 90) => api.get<RunwayResp>(`/api/runway?days=${days}`);

// ── strategy report ──────────────────────────────────────────

export interface StrategyTag {
  tag: string;
  tradeCount: number;
  lastUsed: string | null;
  live: boolean;
}
export const getStrategies = () =>
  api.get<{ ok: true; count: number; strategies: StrategyTag[] }>("/api/strategies");

export interface StrategyReportResp {
  ok: true;
  report: {
    tag: string;
    mode: "real" | "paper";
    window: string;
    generatedAt: string;
    identity?: {
      displayName: string;
      playbookId: number | null;
      playbookStatus: string | null;
      deployedAt: string | null;
      ageSeconds: number | null;
    };
    composition?: {
      totals: { orders: number; schedules: number; rebalances: number };
      lifecycle: Record<string, number>;
      primitives: Array<{
        kind: string; id: number; status: string; summary: string;
        chain: string; account: string; paper: boolean; createdAt: string;
      }>;
    };
    performance?: {
      fills: number; failures: number; successRate: number | null;
      buyCount: number; sellCount: number;
      realizedQuoteSpent: number; realizedQuoteReceived: number; realizedNetQuote: number;
      avgSlippageBps: number | null; p50SlippageBps: number | null; p95SlippageBps: number | null;
    };
    position?: {
      positions: Array<{ chain: string; token: string; symbol: string | null; netAmount: string; role: string }>;
    };
    risk?: {
      budgets: Array<{
        pattern: string;
        lifetimeUsd: number | null; lifetimeSpentUsd: number | null; lifetimePctUsed: number | null;
        dailyUsd: number | null; dailySpentUsd: number | null; dailyPctUsed: number | null;
      }>;
      drawdown: { peakUsd: number; lastValueUsd: number | null; drawdownPct: number | null; tripped: boolean } | null;
    };
    activity?: {
      recentFills: Array<{ at: string; summary: string; txHash: string | null }>;
      recentFailures: Array<{ at: string; summary: string; txHash: string | null }>;
    };
    forward?: {
      nextScheduleAt: string | null;
      nextScheduleId: number | null;
      pendingTriggers: Array<{
        orderId: number; summary?: string; description?: string;
        distancePct?: number | null; [k: string]: unknown;
      }>;
      rebalanceDrift: Array<{
        planId: number; name: string | null; lastDriftPct: number | null;
        thresholdPct: number; pctOfThreshold: number | null; nextRunAt: string;
      }>;
    };
  };
}
export const getStrategyReport = (tag: string, window: string, mode: string) =>
  api.get<StrategyReportResp>(
    `/api/strategy-report/${encodeURIComponent(tag)}?window=${window}&mode=${mode}`,
  );

// ── equity curve ─────────────────────────────────────────────

export interface EquityCurveResp {
  ok: true;
  accountsKey: string;
  chainsKey: string;
  scopeSource: "requested" | "defaulted";
  points: Array<{ at: string; totalUsd: number }>;
  firstUsd: number | null;
  lastUsd: number | null;
  changeAbs: number | null;
  changePct: number | null;
  peakUsd: number | null;
  maxDrawdownPct: number | null;
  risk: {
    returnPct: number;
    maxDrawdownPct: number;
    maxDrawdownUsd: number;
    volatilityPctAnnual: number | null;
    sharpe: number | null;
  } | null;
  availableScopes: Array<{ accountsKey: string; chainsKey: string; count: number; lastAt: string }>;
}
export const getEquity = (since?: string) =>
  api.get<EquityCurveResp>(`/api/equity${since ? `?since=${since}` : ""}`);

// ── realized gains (deterministic) ───────────────────────────

export interface GainsResp {
  ok: true;
  mode: "real" | "paper";
  records: Array<{
    at: string;
    strategy: string;
    symbol: string | null;
    soldAmount: number;
    proceedsQuote: number;
    costBasisQuote: number;
    gainQuote: number;
    txHash: string | null;
  }>;
  totalGainQuote: number;
  totalProceedsQuote: number;
  totalCostBasisQuote: number;
  totalUntrackedProceedsQuote: number;
}
export const getGains = (params: { strategy?: string; mode?: string; since?: string }) => {
  const qs = new URLSearchParams();
  if (params.strategy) qs.set("strategy", params.strategy);
  if (params.mode) qs.set("mode", params.mode);
  if (params.since) qs.set("since", params.since);
  return api.get<GainsResp>(`/api/gains?${qs}`);
};

// ── backtest results (v42) ───────────────────────────────────

export interface BacktestRunSummary {
  id: number;
  strategy_type: "order" | "schedule" | "playbook" | "rebalance";
  chain: string;
  base_symbol: string;
  quote_symbol: string;
  window_start: string;
  window_end: string;
  points: number;
  fire_count: number;
  pnl_usd: number;
  hold_pnl_usd: number;
  vs_hold_usd: number;
  has_metrics: boolean;
  created_at: string;
}

export interface BacktestRiskMetrics {
  returnPct: number;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  peakTs: string | null;
  troughTs: string | null;
  volatilityPctAnnual: number | null;
  sharpe: number | null;
  timeInMarketPct: number;
  equityStartUsd: number;
  equityEndUsd: number;
  curve: Array<{ ts: string; equityUsd: number }>;
}

export interface BacktestRunDetail extends Omit<BacktestRunSummary, "has_metrics"> {
  spec: unknown;
  initial_balance: Record<string, number>;
  final_balance: Record<string, number>;
  fires: Array<{
    ts: string;
    action: string;
    priceUsd: number;
    note?: string;
    strategyId?: string;
    multiAction?: string;
    slippageCostUsd?: number;
    gasCostUsd?: number;
  }>;
  notes: string | null;
  metrics: { metrics: BacktestRiskMetrics | null; holdMetrics: BacktestRiskMetrics | null } | null;
}

export interface BacktestComparisonSummary {
  id: number;
  name: string;
  chain: string;
  base_symbol: string;
  quote_symbol: string;
  window_start: string;
  window_end: string;
  scenario_count: number;
  winner_idx: number | null;
  winner: string | null;
  created_at: string;
}

export interface BacktestComparisonDetail extends Omit<BacktestComparisonSummary, "scenario_count" | "winner"> {
  scenarios: Array<{
    scenarioName: string;
    runId: number;
    pnlUsd: number;
    holdPnlUsd: number;
    vsHoldUsd: number;
    fireCount: number;
    finalUsd: number;
    frictionUsd?: number;
    maxDrawdownPct?: number | null;
  }>;
  run_ids: number[];
}

export const getBacktests = (params: { strategyType?: string; chain?: string; limit?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.strategyType) qs.set("strategyType", params.strategyType);
  if (params.chain) qs.set("chain", params.chain);
  if (params.limit) qs.set("limit", String(params.limit));
  return api.get<{ ok: true; count: number; runs: BacktestRunSummary[] }>(`/api/backtests?${qs}`);
};
export const getBacktest = (id: number) =>
  api.get<{ ok: true; run: BacktestRunDetail }>(`/api/backtests/${id}`);
export const getBacktestComparisons = (limit = 25) =>
  api.get<{ ok: true; count: number; comparisons: BacktestComparisonSummary[] }>(`/api/backtest-comparisons?limit=${limit}`);
export const getBacktestComparison = (id: number) =>
  api.get<{ ok: true; comparison: BacktestComparisonDetail }>(`/api/backtest-comparisons/${id}`);

// ── execution quality (v46) ──────────────────────────────────

export interface SlippageStatsResp {
  samples: number;
  avgBps: number | null;
  medianBps: number | null;
  p90Bps: number | null;
}

export interface ExecutionReportResp {
  ok: true;
  windowLabel: string;
  chain: string | null;
  account: string | null;
  totals: {
    attempts: number;
    fills: number;
    failed: number;
    pending: number;
    successRatePct: number | null;
    usdVolume: number;
    slippage: SlippageStatsResp;
    slippageCoveragePct: number | null;
    gasByChain: Array<{ chain: string; totalNative: number; avgNative: number; samples: number }>;
  };
  byAggregator: Array<{
    aggregator: string;
    fills: number;
    sharePct: number;
    usdVolume: number;
    successRatePct: number | null;
    slippage: SlippageStatsResp;
    avgGasNative: number | null;
  }>;
  byPair: Array<{ baseSymbol: string; fills: number; usdVolume: number; slippage: SlippageStatsResp }>;
  bySize: Array<{ label: string; fills: number; slippage: SlippageStatsResp }>;
  trend: {
    recent: SlippageStatsResp;
    prior: SlippageStatsResp;
    recentDays: number;
    deltaMedianBps: number | null;
  } | null;
  recommendations: string[];
}

export const getExecutionReport = (params: { since?: string; chain?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.since) qs.set("since", params.since);
  if (params.chain) qs.set("chain", params.chain);
  return api.get<ExecutionReportResp>(`/api/execution?${qs}`);
};
