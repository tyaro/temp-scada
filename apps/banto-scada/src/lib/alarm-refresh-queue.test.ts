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
  first.resolve(1);
  await first.promise;
  await Promise.resolve();
  expect(received).toHaveBeenCalledWith(1);
  expect(read).toHaveBeenCalledTimes(2);
  second.resolve(2);
  await second.promise;
  await Promise.resolve();
  expect(received.mock.calls).toEqual([[1], [2]]);
  queue.dispose();
});
