import { describe, expect, it } from "vitest";
import water from "../../../../examples/demo-water.project.json";
import { alarmConditionView } from "../lib/alarm-view";
import { parseHistoryContract } from "../lib/history-contract";
import { historyContext } from "../lib/history/workspace-model";
import { parseProject, type Project } from "../lib/project";
import { createReadPresentationSession } from "../lib/read-presentation";
import { createDemoAlarmFeed } from "./alarm-feed";
import { createDemoHistoryService } from "./history-service";
import { demoUpdate } from "./read-source";
import {
  DEMO_SUBJECTS,
  findDemoSubject,
  parseDemoAt,
  parseDemoView,
} from "./registry";
import {
  createDemoClock,
  demoScenarioFrom,
  type DemoClock,
  type DemoScenario,
} from "./scenario";
import waterScenarioJson from "./scenarios/water.scenario.json";

const waterScenario = demoScenarioFrom(waterScenarioJson);

// Pages のデモの契約。Project は現行の schema で読め、模擬値は製品の読取・警報・履歴の
// 検査をそのまま通る。
const SUBJECTS: [string, unknown, DemoScenario][] = [
  ["water", water, waterScenario],
];
/** 試験が進める時計（`every` は手で呼ぶ）。 */
function manualClock(startSec: number) {
  let nowMs = startSec * 1000;
  const runs: (() => void)[] = [];
  const clock: DemoClock = {
    frozen: true,
    nowMs: () => nowMs,
    every(run) {
      runs.push(run);
      run();
      return () => {};
    },
  };
  return {
    clock,
    to(sec: number) {
      nowMs = sec * 1000;
      for (const run of runs) run();
    },
  };
}

describe("demo subjects", () => {
  it("registers every subject with a loadable Project and scenario", async () => {
    expect(DEMO_SUBJECTS.map((subject) => subject.id)).toEqual(
      SUBJECTS.map(([id]) => id),
    );
    for (const subject of DEMO_SUBJECTS) {
      const project = parseProject(JSON.stringify(await subject.project()));
      expect(project.operatorFrame?.startScreenId).toBe(project.screens[0].id);
      expect((await subject.scenario()).cycleSec).toBeGreaterThan(0);
    }
    expect(findDemoSubject("water")?.title).toBe("排水処理設備");
    expect(findDemoSubject(null)).toBeUndefined();
  });
  it("reads the view and the frozen second from the URL", () => {
    expect(parseDemoView("edit")).toBe("edit");
    expect(parseDemoView("preview")).toBe("preview");
    expect(parseDemoView(null)).toBe("operator");
    expect(parseDemoView("other")).toBe("operator");
    expect(parseDemoAt("70", 180)).toBe(70);
    expect(parseDemoAt("12.5", 180)).toBe(12.5);
    expect(parseDemoAt("180", 180)).toBeUndefined();
    expect(parseDemoAt("-1", 180)).toBeUndefined();
    expect(parseDemoAt(null, 180)).toBeUndefined();
  });
});

describe("scenario clock", () => {
  it("freezes the clock at a phase of the cycle", () => {
    const clock = createDemoClock(waterScenario, 70);
    expect(clock.frozen).toBe(true);
    expect((clock.nowMs() / 1000) % 180).toBe(70);
    let calls = 0;
    clock.every(() => calls++)();
    expect(calls).toBe(1);
  });
});

describe.each(SUBJECTS)("%s demo values", (_id, json, scenario) => {
  const project: Project = parseProject(JSON.stringify(json));
  const cycle = scenario.cycleSec;

  it("gives a value to every tag the Project reads", () => {
    const values = scenario.values(0);
    const update = demoUpdate(project, values, 0, 1);
    for (const [name, reading] of Object.entries(update.text.readings))
      expect(reading.state, name).toBe("resolved");
    for (const row of update.slots.slots)
      expect(row.reading.state, row.externalName ?? "").toBe("resolved");
    for (const definition of project.alarms?.definitions ?? [])
      expect(values, definition.name).toHaveProperty([definition.source.tag]);
    for (const trend of project.trends ?? [])
      for (const pen of trend.pens)
        expect(values, trend.name).toHaveProperty([pen.seriesId]);
  });

  it("passes the product's read presentation checks over the whole cycle", () => {
    const session = createReadPresentationSession(project);
    for (let second = 0; second <= cycle; second++) {
      const update = demoUpdate(
        project,
        scenario.values(second),
        second * 1000,
        second + 1,
      );
      expect(session.receive(session.token, update).accepted, `${second}`).toBe(
        true,
      );
    }
  });

  it("repeats its on-off states after one cycle", () => {
    const base = 10 * cycle;
    const first = scenario.values(base + 42),
      second = scenario.values(base + cycle + 42);
    // 積算・運転時間のような、時刻とともに増える値は周期では戻らない。
    const periodic = Object.keys(first).filter(
      (name) => !/Total|Hours|Count/.test(name),
    );
    for (const name of periodic)
      if (typeof first[name] === "boolean")
        expect(second[name], name).toBe(first[name]);
  });

  it("answers history queries with results the contract accepts", async () => {
    const { clock } = manualClock(1_000_000);
    const service = createDemoHistoryService(project, scenario, clock)!;
    const context = historyContext(service, project);
    expect(context.phase).toBe("ready");
    const seriesIds = [
      ...new Set(
        (project.trends ?? []).flatMap((trend) =>
          trend.pens.map((pen) => pen.seriesId),
        ),
      ),
    ].slice(0, 8);
    for (const mode of ["raw", "minmax"] as const) {
      const query = parseHistoryContract({
        version: 1,
        kind: "query",
        requestId: `demo-${mode}`,
        seriesIds: [...seriesIds, "Unknown.Series"].slice(0, 8),
        // 終わりは現在より先。先の部分は欠測になる。
        fromMs: 1_000_000_000 - 540_000,
        toMs: 1_000_000_000 + 60_000,
        mode,
        maxPointsPerSeries: 300,
      });
      if (query.kind !== "query") throw new Error("query");
      const result = parseHistoryContract(
        await service.source.query(query, {
          signal: new AbortController().signal,
        }),
      );
      if (result.kind !== "result") throw new Error("result");
      expect(result.status).toBe("ready");
      const first = result.series[0];
      expect(first.status).toBe("ready");
      if (mode === "raw") {
        expect(first.raw.length).toBeGreaterThan(100);
        expect(first.raw.at(-1)!.sampleTimeMs).toBeLessThanOrEqual(
          1_000_000_000,
        );
      } else {
        expect(first.bins).toHaveLength(300);
        expect(first.bins[0].state).toBe("complete");
        expect(first.bins.at(-1)!.state).toBe("gap");
      }
    }
  });
});

describe("water demo alarms", () => {
  const project: Project = parseProject(JSON.stringify(water));
  const definition = (name: string) =>
    project.alarms!.definitions.find((row) => row.name === name)!.id;
  const LEVEL = definition("T-101 原水槽 液位");
  const FAULT = definition("P-102 故障");
  // 位相 0 から始まる時刻（周期の倍数）。
  const BASE = 180 * 1000;

  it("raises, returns and acknowledges along the scenario", async () => {
    const time = manualClock(BASE + 30);
    const feed = createDemoAlarmFeed(project, waterScenario, time.clock);
    let lagged = 0;
    await feed.subscribe(
      () => {},
      () => lagged++,
    );
    const state = async (conditionId: string) =>
      alarmConditionView(
        await feed.snapshot(),
        project.manifest.projectId,
        conditionId,
      ).state;
    expect(await state(`${LEVEL}:h`)).toBe("normal");
    expect(await state(FAULT)).toBe("normal");

    // 70 秒: 液位は H を越え、HH の手前。
    time.to(BASE + 70);
    expect(await state(`${LEVEL}:h`)).toBe("activeUnacked");
    expect(await state(`${LEVEL}:hh`)).toBe("normal");
    expect(lagged).toBeGreaterThan(0);
    // 80 秒: HH も発生。
    time.to(BASE + 80);
    expect(await state(`${LEVEL}:hh`)).toBe("activeUnacked");

    // 発生中に確認すると「確認済み」になり、復帰で正常へ戻る。
    const snapshot = await feed.snapshot();
    const hh = snapshot.engine!.conditions[`${LEVEL}:hh`];
    expect(
      await feed.ack!([
        {
          conditionId: `${LEVEL}:hh`,
          occurrence: hh.occurrence!,
          recurrence: hh.recurrence,
        },
      ]),
    ).toEqual([{ conditionId: `${LEVEL}:hh`, result: { kind: "accepted" } }]);
    expect(await state(`${LEVEL}:hh`)).toBe("activeAcked");
    time.to(BASE + 110);
    expect(await state(`${LEVEL}:hh`)).toBe("normal");
    // 確認していない H は、復帰しても「復帰・未確認」で残る。
    expect(await state(`${LEVEL}:h`)).toBe("returnedUnacked");
    // bit の警報（P-102 故障）。
    expect(await state(FAULT)).toBe("activeUnacked");
    time.to(BASE + 150);
    expect(await state(FAULT)).toBe("returnedUnacked");
    expect(await state(`${LEVEL}:l`)).toBe("activeUnacked");

    const history = await feed.history!({
      beforeSeq: null,
      fromMs: null,
      toMs: null,
      kind: null,
      limit: 100,
    });
    expect(history.map((row) => row.event.kind)).toEqual(
      expect.arrayContaining(["occurred", "returned", "acked"]),
    );
    expect(history[0].seq).toBeGreaterThan(history.at(-1)!.seq);
    expect(history.at(-1)!.display?.limitLabel).toBe("H");
  });

  it("keeps history sequences unique after old events are dropped", async () => {
    const time = manualClock(BASE);
    const feed = createDemoAlarmFeed(project, waterScenario, time.clock);
    await feed.snapshot();
    // 保持数（2000 件）を超えるまで筋書きを回す。
    for (let second = 1; second <= 180 * 260; second += 3)
      time.to(BASE + second);
    const page = await feed.history!({
      beforeSeq: null,
      fromMs: null,
      toMs: null,
      kind: null,
      limit: 100,
    });
    expect(page).toHaveLength(100);
    expect(new Set(page.map((row) => row.seq)).size).toBe(100);
    expect(page[0].seq).toBeGreaterThan(2000);
    const next = await feed.history!({
      beforeSeq: page.at(-1)!.seq,
      fromMs: null,
      toMs: null,
      kind: null,
      limit: 100,
    });
    expect(next[0].seq).toBe(page.at(-1)!.seq - 1);
  });

  it("refuses an acknowledgement of another occurrence", async () => {
    const time = manualClock(BASE + 80);
    const feed = createDemoAlarmFeed(project, waterScenario, time.clock);
    await feed.snapshot();
    const results = await feed.ack!([
      { conditionId: `${LEVEL}:hh`, occurrence: "other", recurrence: 0 },
      { conditionId: "missing", occurrence: "other", recurrence: 0 },
    ]);
    expect(results.map((row) => row.result.kind)).toEqual([
      "otherOccurrence",
      "notFound",
    ]);
  });
});
