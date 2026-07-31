import { afterEach, describe, expect, it, vi } from "vitest";

import { RequestScheduler } from "./scheduler.js";

const A = "192.168.1.50";
const B = "192.168.1.51";

// Lets a task be held open until the test decides to let it finish.
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Runs after the microtask queue drains, which is where p-limit dispatches.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("RequestScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one request at a time per address", async () => {
    const scheduler = new RequestScheduler({ gapMs: 0 });
    const order: string[] = [];
    const first = deferred();

    const one = scheduler.run(A, async () => {
      order.push("one started");
      await first.promise;
      order.push("one finished");
    });
    const two = scheduler.run(A, async () => {
      order.push("two started");
    });

    await flush();
    // The second request is waiting on the first, not on the network.
    expect(order).toEqual(["one started"]);

    first.resolve();
    await Promise.all([one, two]);
    expect(order).toEqual(["one started", "one finished", "two started"]);
  });

  it("runs requests to different addresses concurrently", async () => {
    const scheduler = new RequestScheduler({ gapMs: 0 });
    const started: string[] = [];
    const held = deferred();

    const one = scheduler.run(A, async () => {
      started.push(A);
      await held.promise;
    });
    const two = scheduler.run(B, async () => {
      started.push(B);
    });

    await flush();
    // A device that is slow to answer must not hold up a different one.
    expect(started).toEqual([A, B]);
    await two;

    held.resolve();
    await one;
  });

  it("answers the caller without waiting for the gap that follows", async () => {
    vi.useFakeTimers();
    const scheduler = new RequestScheduler({ gapMs: 100 });

    const answered = vi.fn();
    void scheduler.run(A, () => Promise.resolve("done")).then(answered);

    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toHaveBeenCalledWith("done");
  });

  it("leaves the device alone for the gap before the next request", async () => {
    vi.useFakeTimers();
    const scheduler = new RequestScheduler({ gapMs: 100 });
    const started: number[] = [];

    void scheduler.run(A, async () => {
      started.push(1);
    });
    void scheduler.run(A, async () => {
      started.push(2);
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([1]);

    await vi.advanceTimersByTimeAsync(100);
    expect(started).toEqual([1, 2]);
  });

  it("holds the gap after a failed request too", async () => {
    vi.useFakeTimers();
    const scheduler = new RequestScheduler({ gapMs: 100 });
    const started: number[] = [];

    const failing = scheduler.run(A, async () => {
      started.push(1);
      throw new Error("no answer");
    });
    void scheduler.run(A, async () => {
      started.push(2);
    });

    await expect(failing).rejects.toThrow("no answer");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([1]);

    await vi.advanceTimersByTimeAsync(100);
    expect(started).toEqual([1, 2]);
  });

  it("rejects a queued request once closed, without running it", async () => {
    const scheduler = new RequestScheduler({ gapMs: 0 });
    const held = deferred();
    const queued = vi.fn(() => Promise.resolve());

    const running = scheduler.run(A, () => held.promise);
    const waiting = scheduler.run(A, queued);
    await flush();

    scheduler.close();
    held.resolve();

    await running;
    // The point of closing: a request still in the queue must not reach a
    // socket that has already been released.
    await expect(waiting).rejects.toThrow(/closed/);
    expect(queued).not.toHaveBeenCalled();
  });

  it("reports a task that throws on the way in", async () => {
    // Nothing upstream has a timeout of its own, so a caller left holding a
    // promise that never settles would wait forever.
    const scheduler = new RequestScheduler({ gapMs: 0 });
    await expect(
      scheduler.run(A, () => {
        throw new Error("could not send");
      }),
    ).rejects.toThrow("could not send");
  });

  it("rejects a new request once closed", async () => {
    const scheduler = new RequestScheduler({ gapMs: 0 });
    scheduler.close();
    await expect(scheduler.run(A, () => Promise.resolve())).rejects.toThrow(/closed/);
  });

  it("drops the queue of an address once it goes idle", async () => {
    const scheduler = new RequestScheduler({ gapMs: 0 });

    await scheduler.run(A, () => Promise.resolve());
    await scheduler.run(B, () => Promise.resolve());
    // The gap outlives the caller, so the queues are still held right here:
    // wait for it to elapse rather than only for the microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(scheduler.addressCount).toBe(0);
  });
});
