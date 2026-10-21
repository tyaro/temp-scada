import { afterEach, expect, it, vi } from "vitest";
import { createHistoryAssetCollector } from "./history-assets";
import { HISTORY_LIMIT, type EditHistory } from "./history";
const assets = (...hashes: string[]) => hashes.map((sha256) => ({ sha256 }));
const snapshot = (...hashes: string[]) =>
  JSON.stringify({ assets: assets(...hashes) });
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const collector = createHistoryAssetCollector();
  const collect = vi.fn<(hashes: ReadonlySet<string>) => void>();
  const store = { collect };
  const run = (
    current: string[],
    past: string[] = [],
    future: string[] = [],
  ) => {
    collector(assets(...current), { past, future }, store);
    return [...collect.mock.lastCall![0]].sort();
  };
  return { collector, collect, store, run };
}
it("retains the union of current, Undo and Redo assets; current assets are always reread", () => {
  const { run } = fixture(),
    old = snapshot("old"),
    future = snapshot("redo");
  expect(run(["current"], [old], [future])).toEqual(["current", "old", "redo"]);
  expect(run(["new"], [old], [future])).toEqual(["new", "old", "redo"]);
});
it("extracts each exact retained snapshot once while traversing Undo/Redo", () => {
  const { run } = fixture(),
    a = snapshot("a"),
    b = snapshot("b");
  const parse = vi.spyOn(JSON, "parse");
  run(["c"], [a, b]);
  expect(parse).toHaveBeenCalledTimes(2);
  run(["b"], [a], [b]);
  run(["a"], [], [b, a]);
  expect(parse).toHaveBeenCalledTimes(2);
});
it("drops Redo-only entries on a new edit and reparses a subsequently reintroduced snapshot", () => {
  const { run } = fixture(),
    a = snapshot("a"),
    b = snapshot("b");
  const parse = vi.spyOn(JSON, "parse");
  run(["a"], [a], [b]);
  expect(run(["new"], [a])).toEqual(["a", "new"]);
  run(["new"], [a], [b]);
  expect(parse).toHaveBeenCalledTimes(3);
});
it("evicts snapshots dropped at the history limit instead of retaining an unbounded index", () => {
  const { run } = fixture();
  const retained = Array.from({ length: HISTORY_LIMIT }, (_, i) =>
    snapshot(String(i)),
  );
  const parse = vi.spyOn(JSON, "parse");
  run(["current"], retained);
  const next = [...retained.slice(1), snapshot("latest")];
  expect(run(["current"], next)).not.toContain("0");
  expect(parse).toHaveBeenCalledTimes(HISTORY_LIMIT + 1);
  run(["current"], [retained[0]]);
  expect(parse).toHaveBeenCalledTimes(HISTORY_LIMIT + 2);
});
it("failed extraction leaves Store and the previous index untouched", () => {
  const { collector, store, collect, run } = fixture(),
    a = snapshot("a"),
    b = snapshot("b");
  run([], [a]);
  const parse = vi.spyOn(JSON, "parse");
  expect(() =>
    collector([], { past: [b, "invalid JSON"], future: [] }, store),
  ).toThrow();
  expect(collect).toHaveBeenCalledTimes(1);
  run([], [a, b]);
  expect(parse.mock.calls.map(([value]) => value)).toEqual([
    b,
    "invalid JSON",
    b,
  ]);
});
it("new/open history reset clears the index; instances and Store lifetimes are independent", () => {
  const { collector, run } = fixture(),
    a = snapshot("a");
  const parse = vi.spyOn(JSON, "parse");
  run([], [a]);
  expect(run(["new"])).toEqual(["new"]);
  run([], [a]);
  const otherStore = { collect: vi.fn() };
  collector([], { past: [a], future: [] }, otherStore);
  createHistoryAssetCollector()([], { past: [a], future: [] }, otherStore);
  expect(parse).toHaveBeenCalledTimes(3);
  expect(otherStore.collect).toHaveBeenCalledTimes(2);
});
it("the caller cannot mutate private extracted hashes through the supplied collection Set", () => {
  const { collector } = fixture(),
    a = snapshot("a");
  const history: EditHistory = { past: [a], future: [] };
  collector([], history, { collect: (set) => (set as Set<string>).clear() });
  const collect = vi.fn();
  collector([], history, { collect });
  expect([...collect.mock.calls[0][0]]).toEqual(["a"]);
});
