// ──────────────────────────────────────────────────────────────────
// Debounced status writer (iter41): coalesces concurrent writes
// from multiple worker async loops into a bounded write rate.
//
// Pre-iter41 the supervisor wrote the status file at most once per
// "tick round" — synchronous, no contention. With iter41's
// concurrent worker loops, multiple workers can finish ticks at
// roughly the same time + each wants to update their entry in the
// shared EngineStatus.workers[] array. Without coalescing, you get
// either:
//   - N file writes per second (one per worker that just ticked),
//     which is wasteful + lets a reader see partial states, OR
//   - a per-write mutex, which negates the concurrency.
//
// This coalescer batches writes: if any worker calls `request()`
// during a `debounceMs` window, ONE write fires after the window
// expires using the LATEST state at write time. So 5 workers
// finishing ticks within 200ms result in 1 file write that
// reflects all 5.
//
// Design:
//   - `request()` is fire-and-forget — never throws, never blocks
//   - State is computed at write time (caller passes a getter)
//   - `flush()` forces an immediate synchronous write — used by
//     graceful shutdown so the final state lands before exit
//   - `stop()` cancels any pending timer + flushes
// ──────────────────────────────────────────────────────────────────

import { writeFileSync } from "node:fs";
import type { Logger } from "./logger.js";
import type { EngineStatus } from "./engine.js";

export interface StatusWriterArgs {
  /** Absolute path to the status JSON file. */
  path: string;
  /** Coalescing window. Concurrent requests inside the window
   *  collapse to a single trailing write. */
  debounceMs?: number;
  /** Logger used for warn-level failure reporting. Write errors
   *  are NEVER thrown — best-effort persistence. */
  logger: Logger;
  /** Returns the CURRENT EngineStatus snapshot at write time. The
   *  writer doesn't hold a reference to the status — it calls
   *  this every flush so the most-recent in-memory state lands. */
  snapshotFn: () => EngineStatus;
  /** Inject a custom writeFn for tests. */
  writeFn?: (path: string, content: string) => void;
}

export class StatusWriter {
  private readonly args: StatusWriterArgs;
  private readonly debounceMs: number;
  private readonly writeFn: (path: string, content: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Counters for tests. */
  public writeCount = 0;
  public requestCount = 0;

  constructor(args: StatusWriterArgs) {
    this.args = args;
    this.debounceMs = Math.max(0, args.debounceMs ?? 200);
    this.writeFn = args.writeFn ?? defaultWrite;
  }

  /** Ask for a write. If no write is pending, schedules one after
   *  debounceMs. If a write is already pending, the existing timer
   *  stays — the trailing write covers this request too. */
  request(): void {
    if (this.stopped) return;
    this.requestCount += 1;
    if (this.timer != null) return;
    if (this.debounceMs === 0) {
      // Special case: zero debounce = synchronous behavior. Useful
      // for tests + for environments where the operator wants
      // every write reflected immediately.
      this.flushSync();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSync();
    }, this.debounceMs);
    // Don't keep the event loop alive just for the timer. The
    // supervisor's main loop owns liveness; this is a side-channel.
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Force an immediate synchronous write. Used by graceful
   *  shutdown to make sure the final state hits disk. */
  flush(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushSync();
  }

  /** Cancel any pending write + write one final state. After stop()
   *  further request() calls are ignored. */
  stop(): void {
    if (this.stopped) return;
    this.flush();
    this.stopped = true;
  }

  private flushSync(): void {
    let status: EngineStatus;
    try {
      status = this.args.snapshotFn();
    } catch (e) {
      this.args.logger.warn(`statusWriter: snapshot failed: ${(e as Error).message}`);
      return;
    }
    try {
      this.writeFn(this.args.path, JSON.stringify(status, null, 2) + "\n");
      this.writeCount += 1;
    } catch (e) {
      this.args.logger.warn(`statusWriter: write failed: ${(e as Error).message}`);
    }
  }
}

function defaultWrite(path: string, content: string): void {
  writeFileSync(path, content);
}
