import { expect, it, vi } from "vitest";
import { AlarmRefreshQueue } from "./alarm-refresh-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

it("accepts an in-flight snapshot and coalesces rapid refresh requests", async () => {
  const first = deferred<number>();
  const second = deferred<number>();
  const read = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const received = vi.fn();
  const queue = new AlarmRefreshQueue(read, received, vi.fn());
  queue.refresh();
  queue.refresh();
  queue.refresh();
  expect(read).toHaveBeenCalledTimes(1);
  expect(queue.started).toBe(1);
  first.resolve(1);
  await first.promise;
  await Promise.resolve();
  expect(received).toHaveBeenCalledWith(1, 1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(queue.started).toBe(2);
  second.resolve(2);
  await second.promise;
  await Promise.resolve();
  expect(received.mock.calls).toEqual([
    [1, 1],
    [2, 2],
  ]);
  queue.dispose();
});

it("starts a fresh read after a refresh requested while one is in flight", async () => {
  const first = deferred<number>();
  const second = deferred<number>();
  const read = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const received = vi.fn();
  const queue = new AlarmRefreshQueue(read, received, vi.fn());
  queue.refresh();
  // A caller marks the moment, then asks for a read that starts after it.
  const mark = queue.started;
  queue.refresh();
  first.resolve(1);
  await first.promise;
  await Promise.resolve();
  // The in-flight read started before the mark, so it does not count.
  expect(received).toHaveBeenLastCalledWith(1, mark);
  second.resolve(2);
  await second.promise;
  await Promise.resolve();
  expect(received).toHaveBeenLastCalledWith(2, mark + 1);
  queue.dispose();
});
