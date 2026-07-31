import type { LimitFunction } from "p-limit";
import pLimit from "p-limit";

// An ECHONET Lite node services one frame at a time. Asking it for several at
// once earns a Get_SNA rather than an answer, so requests are serialized per
// node rather than globally: two devices are talked to concurrently, two
// requests to the same device are not.
const DEFAULT_CONCURRENCY_PER_ADDRESS = 1;

// Held after each request before the next one to the same node is sent. Nodes
// answer while they are still finishing the previous request, so a pause gives
// them a moment to become ready again.
const DEFAULT_GAP_MS = 50;

const CLOSED_MESSAGE = "ECHONET Lite client closed";

export interface SchedulerOptions {
  concurrencyPerAddress?: number;
  gapMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Serializes requests per device address.
//
// Keyed by address rather than by EOJ because the node, not the object, is what
// can only handle one frame at a time: an air conditioner hosting instances
// 013001 and 013005 answers for both from a single stack.
export class RequestScheduler {
  private readonly limits = new Map<string, LimitFunction>();
  private readonly concurrencyPerAddress: number;
  private readonly gapMs: number;
  private closed = false;

  constructor({
    concurrencyPerAddress = DEFAULT_CONCURRENCY_PER_ADDRESS,
    gapMs = DEFAULT_GAP_MS,
  }: SchedulerOptions = {}) {
    this.concurrencyPerAddress = concurrencyPerAddress;
    this.gapMs = gapMs;
  }

  // Runs `task` once the queue for `address` reaches it. Rejects without running
  // it once the scheduler has been closed, which is what keeps a queued request
  // from reaching a socket that has already been released.
  run<T>(address: string, task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(CLOSED_MESSAGE));
    }

    // The caller waits on the task, while the queue slot is held for the task
    // *and* the gap that follows it. Awaiting the gap on the way out would make
    // every request take that much longer to answer, when the point of it is
    // only to leave the device alone before the next one.
    let settle!: (value: PromiseLike<T>) => void;
    const result = new Promise<T>((resolve) => {
      settle = resolve;
    });

    const limit = this.limitFor(address);
    void limit(async () => {
      if (this.closed) {
        settle(Promise.reject(new Error(CLOSED_MESSAGE)));
        return;
      }
      // Settling before awaiting, and even when starting the task throws: a
      // caller left holding a promise that never settles would wait forever,
      // with no timeout of its own to fall back on.
      let running: Promise<T>;
      try {
        running = task();
      } catch (err) {
        settle(Promise.reject(err instanceof Error ? err : new Error(String(err))));
        return;
      }
      settle(running);
      // Whatever the task did, the device was talked to and is owed the gap.
      // The rejection itself reaches the caller through `result`.
      await running.catch(() => {});
      if (!this.closed) {
        await sleep(this.gapMs);
      }
    }).finally(() => this.releaseIfIdle(address, limit));

    return result;
  }

  // Rejects everything still queued. In-flight requests are left to their own
  // timeouts, which the client arms.
  close(): void {
    this.closed = true;
  }

  // The number of addresses currently holding a queue. Only meaningful to tests,
  // which use it to check that idle queues are dropped.
  get addressCount(): number {
    return this.limits.size;
  }

  private limitFor(address: string): LimitFunction {
    let limit = this.limits.get(address);
    if (limit === undefined) {
      limit = pLimit(this.concurrencyPerAddress);
      this.limits.set(address, limit);
    }
    return limit;
  }

  // A queue with nothing left in it is dropped so a network of transient
  // addresses cannot grow the map without bound.
  //
  // The counts are checked a microtask later: p-limit decrements activeCount in
  // its own continuation, so reading it from this `finally` would still see this
  // very request as active and never drop anything.
  private releaseIfIdle(address: string, limit: LimitFunction): void {
    queueMicrotask(() => {
      if (limit.activeCount === 0 && limit.pendingCount === 0 && this.limits.get(address) === limit) {
        this.limits.delete(address);
      }
    });
  }
}
