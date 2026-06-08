/**
 * Per-account async mutex. Prevents the budget-bypass race where two parallel trades
 * each call `dailyUsdVolume()` before either has inserted its row, both pass safety,
 * and the daily USD cap is exceeded.
 *
 * Scoped per account: trades on independent accounts run concurrently — the lock only
 * serializes calls that compete for the same daily budget.
 *
 * Implementation: each key holds the tail of a promise chain. The next acquirer awaits
 * the current tail and replaces it with its own. The map only ever has one entry per
 * unique account label seen, which is bounded by user setup (typically <10).
 */

const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with the lock for `key` held. Returns whatever `fn` returns. Lock is
 * released even if `fn` throws.
 */
export async function withAccountLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The new tail is "wait for the previous holder, then wait for us". Subsequent
  // acquirers chain onto `next`, ensuring strict FIFO ordering.
  tails.set(
    key,
    prev.then(() => next),
  );
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

/** Stable lock key for an account. */
export function accountLockKey(account: string): string {
  return `acct:${account}`;
}

/** Test-only: visible so tests can assert no growth surprises. */
export function _lockMapSize(): number {
  return tails.size;
}
