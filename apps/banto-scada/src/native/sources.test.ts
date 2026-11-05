import { beforeEach, expect, it, vi } from "vitest";
import sample from "../../../../examples/read-presentation.project.json";
import { parseProject } from "../lib/project";
import { nativeSources } from "./sources";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

beforeEach(() => {
  tauri.invoke.mockReset().mockResolvedValue(undefined);
  tauri.listen.mockReset().mockResolvedValue(vi.fn());
});

it("delivers only the active native subscription and retires it on close", async () => {
  const project = parseProject(JSON.stringify(sample));
  const receive = vi.fn().mockReturnValue(true);
  const close = vi.fn();
  const begin = vi.fn(() => ({ receive, close, fail: vi.fn() }));
  const source = nativeSources().readSource;
  const retire = source.subscribe(project, begin);
  await vi.waitFor(() =>
    expect(tauri.invoke).toHaveBeenCalledWith("hub_read_start", {
      projectJson: JSON.stringify(project),
      subscriptionId: expect.any(String),
    }),
  );
  const subscriptionId = tauri.invoke.mock.calls[0][1].subscriptionId;
  const listener = tauri.listen.mock.calls[0][1];
  listener({ payload: { subscriptionId: "retired", update: { sequence: 1 } } });
  expect(receive).not.toHaveBeenCalled();
  listener({ payload: { subscriptionId, update: { sequence: 2 } } });
  expect(receive).toHaveBeenCalledOnce();
  retire();
  expect(close).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(tauri.invoke).toHaveBeenCalledWith("hub_read_stop", {
      subscriptionId,
    }),
  );
  listener({ payload: { subscriptionId, update: { sequence: 3 } } });
  expect(receive).toHaveBeenCalledOnce();
});

it("fails a delivery when the native read command rejects", async () => {
  tauri.invoke.mockRejectedValueOnce(Error("unavailable"));
  const project = parseProject(JSON.stringify(sample));
  const fail = vi.fn();
  nativeSources().readSource.subscribe(project, () => ({
    receive: vi.fn(),
    close: vi.fn(),
    fail,
  }));
  await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce());
});

it("retires an in-flight start before starting the replacement", async () => {
  let finishFirst!: () => void;
  const firstStart = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  let starts = 0;
  tauri.invoke.mockImplementation((name) => {
    if (name === "hub_read_start" && ++starts === 1) return firstStart;
    return Promise.resolve();
  });
  const project = parseProject(JSON.stringify(sample));
  const source = nativeSources().readSource;
  const begin = () => ({ receive: vi.fn(), close: vi.fn(), fail: vi.fn() });
  const retire = source.subscribe(project, begin);
  await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(1));
  retire();
  source.subscribe(project, begin);
  await vi.waitFor(() => expect(tauri.listen).toHaveBeenCalledTimes(2));
  expect(tauri.invoke).toHaveBeenCalledTimes(1);
  finishFirst();
  await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(3));
  expect(tauri.invoke.mock.calls.map(([name]) => name)).toEqual([
    "hub_read_start",
    "hub_read_stop",
    "hub_read_start",
  ]);
});
