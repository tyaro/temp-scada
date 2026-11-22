import { describe, expect, it } from "vitest";
import type { AlarmConditionState, AlarmSnapshot } from "./alarm-mirror";
import { alarmValueColor } from "./alarm-value-color";
import type { AlarmDefinition, AlarmSeverity } from "./alarms";

const PROJECT = "0199f200-0000-7000-8000-000000000001";
const ID = "t01";

type Kind = "normal" | "unacked" | "acked" | "returned" | "unavailable";
const cond = (kind: Kind, extra: Partial<AlarmConditionState> = {}) =>
  ({
    active: kind === "unacked" || kind === "acked",
    occurrence: null,
    recurrence: 0,
    acked: kind !== "unacked" && kind !== "returned",
    timer: null,
    unavailable: kind === "unavailable" ? "x" : null,
    reportedUnavailable: null,
    orderKey: null,
    occurredAtMs: null,
    observation: null,
    ...extra,
  }) as AlarmConditionState;

/** conditions と、condition id ごとの severity（省略は表示情報なし）から snapshot を作る。 */
function snap(
  conditions: Record<string, AlarmConditionState>,
  severities: Record<string, AlarmSeverity> = {},
  patch: Partial<AlarmSnapshot> = {},
  engineUnavailable: string | null = null,
): AlarmSnapshot {
  const displays: Record<
    string,
    { name: string; message: string; severity?: string; limitLabel: string }
  > = {};
  for (const key of Object.keys(conditions))
    displays[key] = {
      name: "温度",
      message: "m",
      limitLabel: "",
      ...(severities[key] ? { severity: severities[key] } : {}),
    };
  return {
    monitored: { projectId: PROJECT },
    applied: {
      projectId: PROJECT,
      projectRevision: 1,
      appliedAtMs: 1,
      displays,
    },
    engine: {
      session: { id: "s", generation: 1 },
      seq: 1,
      unavailable: engineUnavailable,
      conditions,
    },
    status: "running",
    pendingConditionChanges: false,
    pendingDisplayChanges: false,
    pendingUnknown: false,
    historyWriteFailure: null,
    rereadFailure: null,
    ...patch,
  } as unknown as AlarmSnapshot;
}

const limit = (severity: AlarmSeverity) => ({ value: 1, severity });
const threshold = (
  limits: Partial<Record<"hh" | "h" | "l" | "ll", AlarmSeverity>>,
  extra: Partial<AlarmDefinition> = {},
): AlarmDefinition => ({
  id: ID,
  name: "T-01 温度",
  enabled: true,
  source: {
    kind: "threshold",
    tag: "T",
    limits: Object.fromEntries(
      Object.entries(limits).map(([k, v]) => [k, limit(v)]),
    ),
  },
  ...extra,
});
const bit = (extra: Partial<AlarmDefinition> = {}): AlarmDefinition => ({
  id: ID,
  name: "T-01 温度",
  enabled: true,
  source: { kind: "bit", tag: "B", activeWhen: true },
  ...extra,
});
const run = (
  def: AlarmDefinition,
  snapshot: AlarmSnapshot | null,
  blink = false,
) => alarmValueColor(def, snapshot, PROJECT, blink);

const SEV = {
  [`${ID}:hh`]: "high",
  [`${ID}:h`]: "medium",
  [`${ID}:l`]: "low",
  [`${ID}:ll`]: "high",
} as const;
const BOTH = threshold({ hh: "high", h: "medium" });

/**
 * 組合せの例の 1 行。conditions は condition id の接尾辞（"" は bit の alarmId そのもの）から状態へ。
 * severity・underline は無いことも確かめる（undefined は「付かない」）。title は確かめる行だけ書く。
 */
type Example = {
  name: string;
  def: AlarmDefinition;
  conditions: Record<string, AlarmConditionState>;
  severities?: Record<string, AlarmSeverity>;
  tone: "normal" | "severity" | "unknown";
  severity?: AlarmSeverity;
  underline?: AlarmSeverity;
  title?: string;
};
const at = (suffix: string) => (suffix ? `${ID}:${suffix}` : ID);
const unapplied = "（この警報は適用されていません）";
const EXAMPLES: Example[] = [
  {
    name: "すべて正常",
    def: BOTH,
    conditions: { hh: cond("normal"), h: cond("normal") },
    tone: "normal",
    title: "正常",
  },
  {
    name: "H 発生中・確認済み、HH 発生中・未確認",
    def: BOTH,
    conditions: { hh: cond("unacked"), h: cond("acked") },
    tone: "severity",
    severity: "high",
    underline: "high",
    title: "HH 未確認（発生中）、H 発生中",
  },
  {
    name: "H 発生中・確認済み、HH 復帰・未確認",
    def: BOTH,
    conditions: { hh: cond("returned"), h: cond("acked") },
    tone: "severity",
    severity: "medium",
    underline: "high",
  },
  {
    name: "HH 復帰・未確認、ほかは正常",
    def: BOTH,
    conditions: { hh: cond("returned"), h: cond("normal") },
    tone: "normal",
    underline: "high",
    title: "HH 復帰・未確認",
  },
  {
    name: "HH 復帰・未確認、追加した L が未適用（不明）",
    def: threshold({ hh: "high", h: "medium", l: "low" }),
    conditions: { hh: cond("returned"), h: cond("normal") },
    tone: "unknown",
    underline: "high",
    title: `HH 復帰・未確認、L 不明${unapplied}`,
  },
  {
    name: "編集で外した HH が Engine で発生中・確認済み、H は正常",
    def: threshold({ h: "medium" }),
    conditions: { hh: cond("acked"), h: cond("normal") },
    tone: "severity",
    severity: "high",
  },
  {
    name: "編集で外した HH が Engine で発生中・未確認、H は正常",
    def: threshold({ h: "medium" }),
    conditions: { hh: cond("unacked"), h: cond("normal") },
    tone: "severity",
    severity: "high",
    underline: "high",
  },
  {
    name: "しきい値 → bit へ変えて未適用、Engine の HH が発生中・未確認",
    def: bit(),
    conditions: { hh: cond("unacked") },
    tone: "severity",
    severity: "high",
    underline: "high",
    title: `HH 未確認（発生中）、不明${unapplied}`,
  },
  {
    name: "bit → しきい値へ変えて未適用、Engine の bit が発生中・確認済み",
    def: threshold({ hh: "high" }),
    conditions: { "": cond("acked") },
    severities: { [ID]: "low" },
    tone: "severity",
    severity: "low",
  },
  {
    name: "しきい値 → bit へ変えて未適用、Engine の限界はすべて正常",
    def: bit(),
    conditions: { hh: cond("normal"), h: cond("normal") },
    tone: "unknown",
    title: `不明${unapplied}`,
  },
  {
    name: "追加した LL だけが未適用、ほかは正常",
    def: threshold({ hh: "high", ll: "high" }),
    conditions: { hh: cond("normal") },
    tone: "unknown",
  },
  {
    name: "H 発生中・確認済みで condition 単位の評価不能が重なる",
    def: threshold({ h: "medium" }),
    conditions: { h: cond("acked", { unavailable: "x" }) },
    tone: "severity",
    severity: "medium",
    title: "H 発生中・評価不能",
  },
  {
    name: "H 発生中・未確認で condition 単位の評価不能が重なる",
    def: threshold({ h: "medium" }),
    conditions: { h: cond("unacked", { unavailable: "x" }) },
    tone: "severity",
    severity: "medium",
    underline: "medium",
  },
  {
    name: "評価不能だけ（発生中なし）は不明の灰色",
    def: threshold({ h: "medium" }),
    conditions: { h: cond("unavailable") },
    tone: "unknown",
    title: "H 評価不能",
  },
];

describe("alarmValueColor: 組合せの例の表", () => {
  it.each(EXAMPLES)("$name", (example) => {
    const conditions = Object.fromEntries(
      Object.entries(example.conditions).map(([k, v]) => [at(k), v]),
    );
    const r = run(example.def, snap(conditions, example.severities ?? SEV));
    expect(r).toMatchObject({ tone: example.tone, blink: false });
    expect(r.severity).toBe(example.severity);
    expect(r.underline).toBe(example.underline);
    if (example.title !== undefined)
      expect(r.title).toBe(`警報 T-01 温度: ${example.title}`);
  });

  describe("snapshot が使えない", () => {
    it.each([
      ["snapshot が無い", () => null, "警報の状態を受け取っていません"],
      [
        "Engine が止まっている",
        () => snap({}, {}, { status: "stopped" }),
        "警報の Engine が動いていません",
      ],
      [
        "Engine 単位の評価不能",
        () => snap({ [`${ID}:h`]: cond("acked") }, SEV, {}, "lost"),
        "監視できていません",
      ],
      [
        "別の Project",
        () =>
          snap({ [`${ID}:h`]: cond("acked") }, SEV, {
            monitored: { projectId: "other" },
          } as Partial<AlarmSnapshot>),
        "別の Project を監視中です",
      ],
    ])("%s", (_name, make, text) => {
      const r = run(threshold({ h: "medium" }), make());
      expect(r.tone).toBe("unknown");
      expect(r.underline).toBeUndefined();
      expect(r.blink).toBe(false);
      expect(r.title).toBe(`警報 T-01 温度: 不明（${text}）`);
    });
  });

  it("ackMode: none の H が発生中（Engine は確認済みで持つ）", () => {
    const r = run(
      threshold({ h: "medium" }, { ackMode: "none" }),
      snap({ [`${ID}:h`]: cond("acked") }, SEV),
      true,
    );
    expect(r).toMatchObject({
      tone: "severity",
      severity: "medium",
      blink: false,
    });
    expect(r.underline).toBeUndefined();
  });
});

describe("alarmValueColor: bit の定義", () => {
  it("condition id は alarmId。severity は定義の表示情報から", () => {
    const r = run(bit(), snap({ [ID]: cond("unacked") }, { [ID]: "low" }));
    expect(r).toMatchObject({
      tone: "severity",
      severity: "low",
      underline: "low",
    });
    expect(r.title).toBe("警報 T-01 温度: 未確認（発生中）");
  });

  it("正常は fill、復帰・未確認は下線だけ", () => {
    expect(run(bit(), snap({ [ID]: cond("normal") })).tone).toBe("normal");
    const r = run(bit(), snap({ [ID]: cond("returned") }, { [ID]: "medium" }));
    expect(r).toMatchObject({ tone: "normal", underline: "medium" });
  });
});

describe("alarmValueColor: severity と優先", () => {
  it("severity が表示情報に無いときは high", () => {
    const r = run(bit(), snap({ [ID]: cond("unacked") }));
    expect(r).toMatchObject({ severity: "high", underline: "high" });
  });

  it("H と HH の severity が逆転した定義では severity が先", () => {
    const def = threshold({ hh: "low", h: "high" });
    const sev = { [`${ID}:hh`]: "low", [`${ID}:h`]: "high" } as const;
    const r = run(
      def,
      snap(
        { [`${ID}:hh`]: cond("unacked"), [`${ID}:h`]: cond("unacked") },
        sev,
      ),
    );
    expect(r).toMatchObject({ severity: "high", underline: "high" });
    expect(r.title).toBe(
      "警報 T-01 温度: H 未確認（発生中）、HH 未確認（発生中）",
    );
  });

  it("同じ severity なら HH → LL → H → L、bit は限界の後", () => {
    const all = {
      [`${ID}:hh`]: "high",
      [`${ID}:h`]: "high",
      [`${ID}:l`]: "high",
      [`${ID}:ll`]: "high",
    } as const;
    const r = run(
      threshold({ hh: "high", h: "high", l: "high", ll: "high" }),
      snap(
        {
          [`${ID}:l`]: cond("acked"),
          [`${ID}:h`]: cond("acked"),
          [`${ID}:ll`]: cond("acked"),
          [`${ID}:hh`]: cond("acked"),
          [ID]: cond("acked"),
        },
        all,
      ),
    );
    expect(r.title).toBe(
      "警報 T-01 温度: HH 発生中、LL 発生中、H 発生中、L 発生中、発生中",
    );
  });

  it("文字色は発生中の中、下線は未確認の中で別に決める", () => {
    const def = threshold({ hh: "high", h: "low" });
    const sev = { [`${ID}:hh`]: "high", [`${ID}:h`]: "low" } as const;
    const r = run(
      def,
      snap(
        { [`${ID}:hh`]: cond("returned"), [`${ID}:h`]: cond("unacked") },
        sev,
      ),
    );
    expect(r).toMatchObject({ severity: "low", underline: "high" });
  });
});

describe("alarmValueColor: 無効の定義", () => {
  it("host が condition を作らないので灰色・title は適用されていません", () => {
    const def = threshold({ h: "medium" }, { enabled: false });
    const r = run(def, snap({}));
    expect(r).toMatchObject({ tone: "unknown", blink: false });
    expect(r.underline).toBeUndefined();
    expect(r.title).toBe(
      "警報 T-01 温度: 不明（この警報は適用されていません）",
    );
    const b = run(bit({ enabled: false }), snap({}));
    expect(b.tone).toBe("unknown");
  });
});

describe("alarmValueColor: 点滅", () => {
  const def = threshold({ h: "medium" });
  const un = snap({ [`${ID}:h`]: cond("unacked") }, SEV);
  it("blinkUnacked が真で下線があるときだけ点滅", () => {
    expect(run(def, un, true).blink).toBe(true);
    expect(run(def, un, false).blink).toBe(false);
  });
  it("下線が無ければ blinkUnacked が真でも点滅しない", () => {
    const acked = snap({ [`${ID}:h`]: cond("acked") }, SEV);
    expect(run(def, acked, true)).toMatchObject({
      tone: "severity",
      blink: false,
    });
    expect(run(def, null, true).blink).toBe(false);
  });
  it("復帰・未確認でも点滅する", () => {
    const r = run(def, snap({ [`${ID}:h`]: cond("returned") }, SEV), true);
    expect(r).toMatchObject({
      tone: "normal",
      underline: "medium",
      blink: true,
    });
  });
});

describe("alarmValueColor: 説明文の形", () => {
  it("正常でない condition を優先の順に「限界名 状態」で並べる", () => {
    const r = run(
      BOTH,
      snap({ [`${ID}:hh`]: cond("unacked"), [`${ID}:h`]: cond("acked") }, SEV),
    );
    expect(r.title).toBe("警報 T-01 温度: HH 未確認（発生中）、H 発生中");
  });
  it("正常な condition は並べない", () => {
    const r = run(
      BOTH,
      snap({ [`${ID}:hh`]: cond("normal"), [`${ID}:h`]: cond("acked") }, SEV),
    );
    expect(r.title).toBe("警報 T-01 温度: H 発生中");
  });
});
