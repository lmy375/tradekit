// Tests for the per-account async mutex. The real-world bug this prevents is the
// budget-bypass race: two parallel trades on the same account each pass the safety
// gate because neither has inserted its row yet. We test the primitive directly here;
// the integration is exercised by the smoke script.

import { describe, it, expect } from "vitest";
import { withAccountLock, accountLockKey, _lockMapSize } from "./accountLock.js";

/** Resolves after `ms` — explicit so we can interleave timings reliably. */
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe("withAccountLock", () => {
  it("serializes calls with the same key (second waits for the first to finish)", async () => {
    const order: string[] = [];
    const key = accountLockKey("a-serialize");

    const p1 = withAccountLock(key, async () => {
      order.push("a:start");
      await sleep(40);
      order.push("a:end");
    });
    // Tiny gap so p1 reaches its sleep before p2 is even queued.
    await sleep(5);
    const p2 = withAccountLock(key, async () => {
      order.push("b:start");
      order.push("b:end");
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("runs in parallel across different keys", async () => {
    const order: string[] = [];
    const p1 = withAccountLock(accountLockKey("alice"), async () => {
      order.push("alice:start");
      await sleep(40);
      order.push("alice:end");
    });
    await sleep(5);
    const p2 = withAccountLock(accountLockKey("bob"), async () => {
      order.push("bob:start");
      // Bob finishes before Alice — proves they run concurrently.
      order.push("bob:end");
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(["alice:start", "bob:start", "bob:end", "alice:end"]);
  });

  it("releases the lock when fn throws so subsequent callers can proceed", async () => {
    const key = accountLockKey("a-throw");
    const failure = withAccountLock(key, async () => {
      throw new Error("boom");
    });
    await expect(failure).rejects.toThrow(/boom/);
    // Second call must NOT hang waiting forever for the first's release.
    const result = await withAccountLock(key, async () => "ok");
    expect(result).toBe("ok");
  });

  it("preserves FIFO across many queued callers (no starvation)", async () => {
    const key = accountLockKey("a-fifo");
    const ids: number[] = [];
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 8; i++) {
      const me = i;
      tasks.push(
        withAccountLock(key, async () => {
          // A small await ensures the runtime actually has to honor the lock.
          await sleep(1);
          ids.push(me);
        }),
      );
    }
    await Promise.all(tasks);
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("returns the value from fn", async () => {
    const out = await withAccountLock(accountLockKey("a-return"), async () => 42);
    expect(out).toBe(42);
  });

  it("does not grow the map beyond one entry per unique key", async () => {
    const before = _lockMapSize();
    await withAccountLock(accountLockKey("unique-1"), async () => {});
    await withAccountLock(accountLockKey("unique-1"), async () => {});
    await withAccountLock(accountLockKey("unique-2"), async () => {});
    const after = _lockMapSize();
    // Two unique keys → at most +2 entries (the map is module-global so other tests'
    // keys may have leaked in too; assert the delta, not absolute size).
    expect(after - before).toBeLessThanOrEqual(2);
  });
});
