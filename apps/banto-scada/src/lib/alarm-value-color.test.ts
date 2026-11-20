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

describe("alarmValueColor: 組合せの例の表", () => {
  it("すべて正常", () => {
    const r = run(
      BOTH,
      snap({ [`${ID}:hh`]: cond("normal"), [`${ID}:h`]: cond("normal") }, SEV),
    );
    expect(r).toMatchObject({
      tone: "normal",
      blink: false,
      title: "警報 T-01 温度: 正常",
    });
    expect(r.underline).toBeUndefined();
    expect(r.severity).toBeUndefined();
  });

  it("H 発生中・確認済み、HH 発生中・未確認", () => {
    const r = run(
      BOTH,
      snap({ [`${ID}:hh`]: cond("unacked"), [`${ID}:h`]: cond("acked") }, SEV),
    );
    expect(r).toMatchObject({
      tone: "severity",
      severity: "high",
      underline: "high",
    });
    expect(r.title).toBe("警報 T-01 温度: HH 未確認（発生中）、H 発生中");
  });

  it("H 発生中・確認済み、HH 復帰・未確認", () => {
    const r = run(
      BOTH,
      snap({ [`${ID}:hh`]: cond("returned"), [`${ID}:h`]: cond("acked") }, SEV),
    );
    expect(r).toMatchObject({
      tone: "severity",
      severity: "medium",
      underline: "high",
    });
  });

  it("HH 復帰・未確認、ほかは正常", () => {
    const r = run(
      BOTH,
      snap(
        { [`${ID}:hh`]: cond("returned"), [`${ID}:h`]: cond("normal") },
        SEV,
      ),
    );
    expect(r).toMatchObject({ tone: "normal", underline: "high" });
    expect(r.severity).toBeUndefined();
    expect(r.title).toBe("警報 T-01 温度: HH 復帰・未確認");
  });

  it("HH 復帰・未確認、追加した L が未適用（不明）", () => {
    const def = threshold({ hh: "high", h: "medium", l: "low" });
    const r = run(
      def,
      snap(
        { [`${ID}:hh`]: cond("returned"), [`${ID}:h`]: cond("normal") },
        SEV,
      ),
    );
    expect(r).toMatchObject({ tone: "unknown", underline: "high" });
    expect(r.title).toBe(
      "警報 T-01 温度: HH 復帰・未確認、L 不明（この警報は適用されていません）",
    );
  });

  it("編集で外した HH が Engine で発生中、H は正常", () => {
    const def = threshold({ h: "medium" });
    const s = (kind: Kind) =>
      snap({ [`${ID}:hh`]: cond(kind), [`${ID}:h`]: cond("normal") }, SEV);
    expect(run(def, s("acked"))).toMatchObject({
      tone: "severity",
      severity: "high",
    });
    expect(run(def, s("acked")).underline).toBeUndefined();
    expect(run(def, s("unacked"))).toMatchObject({
      tone: "severity",
      severity: "high",
      underline: "high",
    });
  });

  it("しきい値 → bit へ変えて未適用、Engine の HH が発生中・未確認", () => {
    const r = run(bit(), snap({ [`${ID}:hh`]: cond("unacked") }, SEV));
    expect(r).toMatchObject({
      tone: "severity",
      severity: "high",
      underline: "high",
    });
    expect(r.title).toBe(
      "警報 T-01 温度: HH 未確認（発生中）、不明（この警報は適用されていません）",
    );
  });

  it("bit → しきい値へ変えて未適用、Engine の bit が発生中・確認済み", () => {
    const r = run(
      threshold({ hh: "high" }),
      snap({ [ID]: cond("acked") }, { [ID]: "low" }),
    );
    expect(r).toMatchObject({ tone: "severity", severity: "low" });
    expect(r.underline).toBeUndefined();
  });

  it("しきい値 → bit へ変えて未適用、Engine の限界はすべて正常", () => {
    const r = run(
      bit(),
      snap({ [`${ID}:hh`]: cond("normal"), [`${ID}:h`]: cond("normal") }, SEV),
    );
    expect(r).toMatchObject({ tone: "unknown" });
    expect(r.underline).toBeUndefined();
    expect(r.title).toBe(
      "警報 T-01 温度: 不明（この警報は適用されていません）",
    );
  });

  it("追加した LL だけが未適用、ほかは正常", () => {
    const def = threshold({ hh: "high", ll: "high" });
    const r = run(def, snap({ [`${ID}:hh`]: cond("normal") }, SEV));
    expect(r).toMatchObject({ tone: "unknown", blink: false });
    expect(r.underline).toBeUndefined();
  });

  it("H 発生中で condition 単位の評価不能が重なる", () => {
    const def = threshold({ h: "medium" });
    const acked = run(
      def,
      snap({ [`${ID}:h`]: cond("acked", { unavailable: "x" }) }, SEV),
    );
    expect(acked).toMatchObject({ tone: "severity", severity: "medium" });
    expect(acked.underline).toBeUndefined();
    expect(acked.title).toBe("警報 T-01 温度: H 発生中・評価不能");
    const unacked = run(
      def,
      snap({ [`${ID}:h`]: cond("unacked", { unavailable: "x" }) }, SEV),
    );
    expect(unacked).toMatchObject({ tone: "severity", underline: "medium" });
  });

  it("評価不能だけ（発生中なし）は不明の灰色", () => {
    const r = run(
      threshold({ h: "medium" }),
      snap({ [`${ID}:h`]: cond("unavailable") }, SEV),
    );
    expect(r.tone).toBe("unknown");
    expect(r.title).toBe("警報 T-01 温度: H 評価不能");
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
