import { describe, expect, it } from "vitest";
import fixtures from "../../../../../examples/history-query-cases.json";
import {
  parseHistoryContract,
  type HistoryQuery,
  type HistoryResult,
} from "../history-contract";
import {
  createHistoryController,
  HistorySourceError,
  sameHistoryQuery,
  type HistorySource,
} from "./presentation";
import { ownHistoryJson } from "./owned-json";

function result(): HistoryResult {
  const parsed = parseHistoryContract(fixtures[0].expected);
  if (parsed.kind !== "result") throw Error("fixture");
  return parsed;
}
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
function harness() {
  const calls: {
    query: HistoryQuery;
    signal: AbortSignal;
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }[] = [];
  const source: HistorySource = {
    query(query, { signal }) {
      return new Promise((resolve, reject) =>
        calls.push({ query, signal, resolve, reject }),
      );
    },
  };
  return { calls, source };
}

it("owns and freezes both query and response, including source mutation", async () => {
  const h = harness(),
    controller = createHistoryController(h.source);
  const reply = result(),
    query = structuredClone(reply.query);
  controller.load(query);
  query.fromMs = 0;
  await flush();
  expect(h.calls[0].query.fromMs).toBe(reply.query.fromMs);
  h.calls[0].query.requestId = "source-mutated";
  h.calls[0].resolve(reply);
  await flush();
  expect(controller.state.phase).toBe("ready");
  const accepted = controller.state.result!;
  reply.series[0].raw[1].value = true;
  expect(accepted.series[0].raw[1].value).toBe(false);
  expect(Object.isFrozen(accepted.series[0].raw[0])).toBe(true);
  expect(controller.cancel()).toBe(false);
  expect(controller.state.result).toBe(accepted);
  expect(() => {
    accepted.series[0].raw.length = 0;
  }).toThrow();
});

it("runs one physical request and retains only the latest pending query", async () => {
  const h = harness(),
    controller = createHistoryController(h.source);
  controller.load(result().query);
  await flush();
  for (let i = 0; i < 50; i++)
    controller.load({ ...result().query, requestId: `new-${i}` });
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].signal.aborted).toBe(true);
  expect(controller.state.waiting).toBe(true);
  expect(controller.state.result).toBeUndefined();
  h.calls[0].resolve(result());
  await flush();
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1].query.requestId).toBe("new-49");
  const fresh = result();
  fresh.query.requestId = "new-49";
  h.calls[1].resolve(fresh);
  await flush();
  expect(controller.state.phase).toBe("ready");
});

it("retires old source responses/rejections and waits for their cleanup", async () => {
  const a = harness(),
    b = harness(),
    controller = createHistoryController(a.source);
  controller.load(result().query);
  await flush();
  controller.setSource(b.source);
  expect(controller.state.phase).toBe("idle");
  controller.load(result().query);
  await flush();
  expect(b.calls).toHaveLength(0);
  a.calls[0].reject(Error("secret old failure"));
  await flush();
  expect(b.calls).toHaveLength(1);
  expect(controller.state.phase).toBe("loading");
  b.calls[0].resolve(result());
  await flush();
  expect(controller.state.phase).toBe("ready");
  controller.setSource(undefined);
  expect(controller.state.phase).toBe("offline");
  expect(controller.state.result).toBeUndefined();
});

it("rejects mismatched full query and invalid current payload without retaining old graph", async () => {
  const h = harness(),
    controller = createHistoryController(h.source);
  controller.load(result().query);
  await flush();
  const wrong = result();
  wrong.query.maxPointsPerSeries++;
  h.calls[0].resolve(wrong);
  await flush();
  expect(controller.state.errorCode).toBe("queryMismatch");
  controller.load(result().query);
  await flush();
  h.calls[1].resolve({ kind: "result" });
  await flush();
  expect(controller.state.phase).toBe("invalid");
  expect(controller.state.result).toBeUndefined();
});

it("compares every query field and series order rather than object key order", () => {
  const query = result().query;
  expect(
    sameHistoryQuery(query, { ...query, seriesIds: [...query.seriesIds] }),
  ).toBe(true);
  for (const key of [
    "version",
    "kind",
    "requestId",
    "fromMs",
    "toMs",
    "mode",
    "maxPointsPerSeries",
    "seriesIds",
  ] as const) {
    const altered: any = structuredClone(query);
    altered[key] =
      key === "seriesIds"
        ? [...query.seriesIds].reverse()
        : typeof altered[key] === "number"
          ? altered[key] + 1
          : `${altered[key]}-other`;
    expect(sameHistoryQuery(query, altered)).toBe(false);
  }
});

it("distinguishes partial/unavailable and safe typed or generic operation errors", async () => {
  const h = harness(),
    controller = createHistoryController(h.source);
  const partial = result();
  partial.status = "partial";
  partial.series[0] = {
    seriesId: partial.series[0].seriesId,
    status: "queryUnavailable",
    segments: [],
    raw: [],
    bins: [],
    coverage: [],
    watermark: null,
  };
  controller.load(partial.query);
  await flush();
  h.calls[0].resolve(partial);
  await flush();
  expect(controller.state.phase).toBe("partial");
  const unavailable = result();
  unavailable.status = "unavailable";
  unavailable.snapshotId = null;
  unavailable.series = unavailable.series.map((row) => ({
    seriesId: row.seriesId,
    status: "queryUnavailable",
    segments: [],
    raw: [],
    bins: [],
    coverage: [],
    watermark: null,
  }));
  controller.load(unavailable.query);
  await flush();
  h.calls[1].resolve(unavailable);
  await flush();
  expect(controller.state.phase).toBe("unavailable");
  controller.load(result().query);
  await flush();
  h.calls[2].reject(new HistorySourceError("tooManyPoints"));
  await flush();
  expect(controller.state.errorCode).toBe("tooManyPoints");
  controller.load(result().query);
  await flush();
  h.calls[3].reject(Error("secret driver path"));
  await flush();
  expect(controller.state.errorCode).toBe("failed");
  expect(JSON.stringify(controller.state)).not.toContain("secret");
});

it("cancel is exact-token aware and disposal is terminal even for late source work", async () => {
  const h = harness(),
    controller = createHistoryController(h.source);
  const old = controller.load(result().query)!;
  await flush();
  const current = controller.load(result().query)!;
  expect(controller.cancel(old)).toBe(false);
  expect(controller.cancel(current)).toBe(true);
  h.calls[0].resolve(result());
  await flush();
  expect(h.calls).toHaveLength(1);
  expect(controller.state.phase).toBe("cancelled");
  controller.load(result().query);
  await flush();
  controller.dispose();
  h.calls[1].resolve(result());
  await flush();
  expect(controller.state.phase).toBe("disposed");
  expect(controller.load(result().query)).toBeUndefined();
  expect(controller.cancel()).toBe(false);
});

it("invalid queries clear graphs before reaching a source and synchronous source errors are safe", async () => {
  const h = harness(),
    controller = createHistoryController(h.source);
  controller.load({ ...result().query, seriesIds: ["x", "x"] });
  await flush();
  expect(controller.state.errorCode).toBe("query");
  expect(h.calls).toHaveLength(0);
  controller.setSource({
    query() {
      throw Error("private endpoint");
    },
  });
  controller.load(result().query);
  await flush();
  expect(controller.state.phase).toBe("error");
  expect(JSON.stringify(controller.state)).not.toContain("private");
});

it("handles reentrant subscribers and abort listeners without resurrecting an outer request", async () => {
  const h = harness(),
    controller = createHistoryController(h.source);
  controller.subscribe((state) => {
    if (state.query?.requestId === "outer" && state.phase === "loading")
      controller.load({ ...result().query, requestId: "inner" });
  });
  controller.load({ ...result().query, requestId: "outer" });
  await flush();
  expect(h.calls[0].query.requestId).toBe("inner");
  h.calls[0].signal.addEventListener(
    "abort",
    () => controller.load({ ...result().query, requestId: "abort-inner" }),
    { once: true },
  );
  controller.load({ ...result().query, requestId: "abort-outer" });
  h.calls[0].resolve(result());
  await flush();
  expect(h.calls[1].query.requestId).toBe("abort-inner");
});

describe("bounded plain JSON ownership", () => {
  it("uses exact UTF-8 JSON size including escaped controls and surrogate pairs", () => {
    for (const value of [
      null,
      false,
      1e308,
      -0,
      '日本😀\n\t\u0001"\\\ud800\udfff',
      { a: [1, true, "x"] },
    ]) {
      const size = new TextEncoder().encode(JSON.stringify(value)).length;
      expect(ownHistoryJson(value, size)).toEqual(value);
      expect(() => ownHistoryJson(value, size - 1)).toThrow();
    }
  });
  it("rejects non-JSON ownership hazards without invoking getters", () => {
    let invoked = false;
    const accessor = Object.defineProperty({}, "x", {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });
    const cycle: any = {};
    cycle.self = cycle;
    const symbol = { [Symbol("x")]: 1 };
    for (const value of [
      accessor,
      cycle,
      symbol,
      new Date(),
      new Map(),
      { x: undefined },
      { x: () => 1 },
      { x: 1n },
      { x: Infinity },
      [, 1],
    ])
      expect(() => ownHistoryJson(value, 8192)).toThrow();
    expect(invoked).toBe(false);
  });
  it("bounds depth/nodes and safely owns a complete 8000-row-sized payload", () => {
    let deep: unknown = null;
    for (let i = 0; i < 34; i++) deep = [deep];
    expect(() => ownHistoryJson(deep, 8192)).toThrow();
    expect(() =>
      ownHistoryJson(Array(250_001).fill(null), 8 * 1024 * 1024),
    ).toThrow();
    const sample = result().series[0].raw[0];
    const input = { rows: Array(8000).fill(sample) };
    const owned = ownHistoryJson(input, 8 * 1024 * 1024) as typeof input;
    expect(owned.rows).toHaveLength(8000);
    expect(owned.rows[0]).not.toBe(owned.rows[1]);
  });
});
