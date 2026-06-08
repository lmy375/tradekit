/**
 * Per-strategy USD spend caps.
 *
 * Pre-iter19 the safety system had GLOBAL caps (per-tx, daily) plus
 * PORTFOLIO-COMPOSITION caps (position limits). What it lacked was
 * per-strategy budgeting: "this playbook can spend at most $5000
 * lifetime", "this experiment can spend $200/day", "this DCA leg
 * can never exceed $50 per fire". This module fills that gap.
 *
 * Mechanism. Each trade carries a `strategy` tag (manual operator
 * label, or `playbook:<id>` stamped automatically by the playbook
 * deploy flow). When a trade attempts, we look up the configured
 * budgets that match the tag, sum the already-spent USD under that
 * tag from the `trades` table, and reject if adding the predicted
 * USD would exceed any cap.
 *
 * Tag matching:
 *   - exact:  "arb-experiment" matches that literal value
 *   - suffix wildcard: "playbook:*" matches "playbook:1", "playbook:2", …
 * Multiple rules can match a single trade — ALL must pass.
 *
 * Untagged trades skip the check (no implicit global rule). Operators
 * who want a default budget on every trade should set
 * safety.maxUsdPerTx + maxUsdPerDay — different semantic, different
 * column.
 *
 * The aggregator query uses the (strategy, timestamp) composite index
 * added in v18 migration; the lifetime path scans by strategy alone,
 * the daily path adds a timestamp predicate that the index also serves.
 */

import { ToolError } from "./errors.js";
import { usdSpentUnderStrategy, listDistinctStrategies } from "./db.js";

// ── types ────────────────────────────────────────────────────

export interface BudgetRule {
  /** Strategy tag pattern. Exact match (e.g. "arb-bot") or suffix
   *  wildcard (e.g. "playbook:*"). Pre-validated by Zod schema. */
  tag: string;
  /** Cumulative USD cap across all time. */
  lifetimeUsd?: number;
  /** Rolling 24h USD cap. */
  dailyUsd?: number;
  /** Per-trade cap. Stricter than safety.maxUsdPerTx because it scopes
   *  to ONE strategy — operators commonly want a strategy-specific
   *  per-fire ceiling separate from the global one. */
  perFireUsd?: number;
}

export interface BudgetEvaluation {
  /** True iff every matching rule's caps would still be satisfied
   *  after adding the predicted USD. */
  allowed: boolean;
  /** When allowed=false, the specific rule + cap that tripped. Carries
   *  enough detail to render a structured error + a next-action hint.
   *  Only the FIRST trip is reported (no point computing the rest). */
  trippedRule?: BudgetRule;
  /** Which cap window tripped: "lifetime", "daily", or "perFire". */
  trippedWindow?: "lifetime" | "daily" | "perFire";
  /** USD already spent under this tag in the tripped window (0 for
   *  perFire, since per-fire isn't cumulative). */
  spentUsd?: number;
  /** USD value of the trade being checked. */
  predictedUsd?: number;
  /** The cap that was tripped, in USD. */
  capUsd?: number;
}

// ── tag matching ─────────────────────────────────────────────

/**
 * Pure tag-matcher. A rule matches when:
 *   - rule.tag is an exact literal that equals the trade's tag, OR
 *   - rule.tag ends with "*" and the trade's tag has the prefix.
 *
 * Returns false on empty / null trade tags — no rules apply to
 * untagged trades.
 */
export function ruleMatchesTag(rule: BudgetRule, tradeTag: string | null | undefined): boolean {
  if (!tradeTag) return false;
  if (rule.tag === tradeTag) return true;
  if (rule.tag.endsWith("*")) {
    const prefix = rule.tag.slice(0, -1);
    return tradeTag.startsWith(prefix) && tradeTag.length > prefix.length;
  }
  return false;
}

/** Collect every rule that matches the given tag. Used by the budget
 *  evaluator + the CLI inspection view. */
export function rulesMatchingTag(rules: BudgetRule[], tradeTag: string | null | undefined): BudgetRule[] {
  if (!tradeTag) return [];
  return rules.filter((r) => ruleMatchesTag(r, tradeTag));
}

// ── pure evaluator ───────────────────────────────────────────

/**
 * Pure evaluator: given a rule + the trade's predicted USD + the
 * already-spent totals (lifetime, daily) — does the rule allow this
 * trade?
 *
 * Returns the EvaluationOutcome for one rule. Caller (evaluateBudget)
 * iterates over matching rules and aggregates outcomes.
 *
 * Split out as a pure function so the test suite can verify each
 * window's threshold semantic (equal-to-cap = block; strictly under
 * cap = allow) without standing up the DB query path.
 */
export function evaluateRule(args: {
  rule: BudgetRule;
  predictedUsd: number;
  spentLifetimeUsd: number;
  spentDailyUsd: number;
}): BudgetEvaluation {
  const { rule, predictedUsd, spentLifetimeUsd, spentDailyUsd } = args;

  // perFire is the cheapest — check first. A trade that exceeds the
  // per-fire cap fails regardless of history.
  if (rule.perFireUsd != null && predictedUsd > rule.perFireUsd) {
    return {
      allowed: false,
      trippedRule: rule,
      trippedWindow: "perFire",
      predictedUsd,
      capUsd: rule.perFireUsd,
      spentUsd: 0,
    };
  }

  if (rule.dailyUsd != null && spentDailyUsd + predictedUsd > rule.dailyUsd) {
    return {
      allowed: false,
      trippedRule: rule,
      trippedWindow: "daily",
      spentUsd: spentDailyUsd,
      predictedUsd,
      capUsd: rule.dailyUsd,
    };
  }

  if (rule.lifetimeUsd != null && spentLifetimeUsd + predictedUsd > rule.lifetimeUsd) {
    return {
      allowed: false,
      trippedRule: rule,
      trippedWindow: "lifetime",
      spentUsd: spentLifetimeUsd,
      predictedUsd,
      capUsd: rule.lifetimeUsd,
    };
  }

  return { allowed: true };
}

/**
 * Aggregate evaluation across every rule matching a tag. Returns the
 * first failure (most restrictive rule wins), or allowed=true when
 * all rules pass.
 */
export function evaluateBudget(args: {
  matchingRules: BudgetRule[];
  predictedUsd: number;
  spentLifetimeUsd: number;
  spentDailyUsd: number;
}): BudgetEvaluation {
  for (const rule of args.matchingRules) {
    const outcome = evaluateRule({
      rule,
      predictedUsd: args.predictedUsd,
      spentLifetimeUsd: args.spentLifetimeUsd,
      spentDailyUsd: args.spentDailyUsd,
    });
    if (!outcome.allowed) return outcome;
  }
  return { allowed: true };
}

// ── DB-backed enforcer ───────────────────────────────────────

/** Throwing wrapper. Looks up matching rules, queries the DB for
 *  current consumption, evaluates, and throws STRATEGY_BUDGET_EXCEEDED
 *  on failure with the structured details a downstream agent / CLI
 *  needs.
 *
 *  A null/empty strategy tag short-circuits to a no-op (no rules match
 *  untagged trades). A configured-but-empty `strategyBudgets` array
 *  also short-circuits — pure pre-DB-query.
 */
export function enforceStrategyBudget(args: {
  strategyTag: string | null | undefined;
  predictedUsd: number;
  budgets: BudgetRule[] | undefined;
  /** Injection seam for tests — defaults to the real DB helper. */
  spentLookup?: (tag: string, sinceIso?: string) => number;
}): void {
  const { strategyTag, predictedUsd, budgets } = args;
  if (!budgets || budgets.length === 0) return;
  if (!strategyTag) return;
  if (!(predictedUsd > 0) || !Number.isFinite(predictedUsd)) return;

  const matching = rulesMatchingTag(budgets, strategyTag);
  if (matching.length === 0) return;

  // Only query the DB if AT LEAST ONE matching rule needs the lookup
  // (perFire-only rules don't need consumption). Cheap optimization on
  // the hot path — most trades hit zero matching rules anyway.
  const needsLifetime = matching.some((r) => r.lifetimeUsd != null);
  const needsDaily = matching.some((r) => r.dailyUsd != null);
  const lookup = args.spentLookup ?? usdSpentUnderStrategy;
  const spentLifetimeUsd = needsLifetime ? lookup(strategyTag) : 0;
  const spentDailyUsd = needsDaily
    ? lookup(strategyTag, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    : 0;

  const evalRes = evaluateBudget({
    matchingRules: matching,
    predictedUsd,
    spentLifetimeUsd,
    spentDailyUsd,
  });
  if (evalRes.allowed) return;

  // Build the structured error. `nextActions` points at the
  // strategies + config inspection commands so an operator (or agent)
  // knows where to look next.
  const window = evalRes.trippedWindow!;
  const cap = evalRes.capUsd!.toFixed(2);
  const predicted = evalRes.predictedUsd!.toFixed(2);
  const spent = (evalRes.spentUsd ?? 0).toFixed(2);
  const windowDescription =
    window === "perFire"
      ? `per-fire cap`
      : window === "daily"
        ? `24h-rolling cap (already spent $${spent})`
        : `lifetime cap (already spent $${spent})`;
  throw new ToolError(
    "STRATEGY_BUDGET_EXCEEDED",
    `Strategy budget exceeded for tag "${strategyTag}": trade $${predicted} ${
      window === "perFire" ? "exceeds" : "would push spend over"
    } ${windowDescription} of $${cap}.`,
    {
      details: {
        tag: strategyTag,
        matchedRule: evalRes.trippedRule,
        window,
        capUsd: evalRes.capUsd,
        spentUsd: evalRes.spentUsd,
        predictedUsd: evalRes.predictedUsd,
      },
      nextActions: [
        {
          tool: "strategies_list",
          reason: `Inspect current budget consumption with \`tradekit strategies --budget\` to see remaining headroom across all rules.`,
        },
        {
          tool: "config",
          reason: `Adjust the cap via \`tradekit config set safety.strategyBudgets ...\` if the limit is genuinely too low (audit the cause first — a runaway loop is the usual root cause).`,
        },
      ],
    },
  );
}

// ── inspection view ──────────────────────────────────────────

export interface BudgetConsumption {
  rule: BudgetRule;
  lifetimeSpentUsd: number | null;
  dailySpentUsd: number | null;
  /** Tags currently in the DB that match this rule (for `playbook:*`
   *  patterns, multiple). Empty when no trades have been tagged under
   *  the pattern yet. */
  matchedTags: string[];
  remaining: {
    lifetime: number | null;
    daily: number | null;
    perFire: number | null;
  };
}

/**
 * Compute live consumption + remaining budget for every configured
 * rule. Used by `tradekit strategies --budget` to render the
 * operator-facing dashboard.
 *
 * For exact-tag rules, this is a single SUM query per window.
 * For wildcard rules, we enumerate distinct strategies from the
 * `trades` table that match the pattern + sum each. The
 * `distinctStrategiesFn` injection seam lets tests stub the DB
 * enumeration cheaply.
 */
export function computeBudgetConsumption(args: {
  budgets: BudgetRule[];
  spentLookup?: (tag: string, sinceIso?: string) => number;
  distinctStrategiesFn?: () => string[];
}): BudgetConsumption[] {
  const lookup = args.spentLookup ?? usdSpentUnderStrategy;
  const allTagsFn = args.distinctStrategiesFn ?? defaultDistinctStrategies;
  const allTagsLazy = lazyEval(allTagsFn);
  const dailySinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  return args.budgets.map((rule) => {
    const matchedTags = rule.tag.endsWith("*")
      ? allTagsLazy().filter((t) => ruleMatchesTag(rule, t))
      : [rule.tag];

    let lifetimeSpent = 0;
    let dailySpent = 0;
    for (const t of matchedTags) {
      if (rule.lifetimeUsd != null) lifetimeSpent += lookup(t);
      if (rule.dailyUsd != null) dailySpent += lookup(t, dailySinceIso);
    }

    return {
      rule,
      lifetimeSpentUsd: rule.lifetimeUsd != null ? lifetimeSpent : null,
      dailySpentUsd: rule.dailyUsd != null ? dailySpent : null,
      matchedTags,
      remaining: {
        lifetime: rule.lifetimeUsd != null ? Math.max(0, rule.lifetimeUsd - lifetimeSpent) : null,
        daily: rule.dailyUsd != null ? Math.max(0, rule.dailyUsd - dailySpent) : null,
        perFire: rule.perFireUsd ?? null,
      },
    };
  });
}

function lazyEval<T>(fn: () => T): () => T {
  let cached: T | undefined;
  return () => {
    if (cached === undefined) cached = fn();
    return cached;
  };
}

function defaultDistinctStrategies(): string[] {
  // CLI-only call path; the trade.ts hot path goes through
  // enforceStrategyBudget which never reaches here.
  return listDistinctStrategies({})
    .map((r) => r.strategy)
    .filter((s): s is string => s != null);
}
