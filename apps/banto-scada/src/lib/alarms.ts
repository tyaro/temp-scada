import type { Project } from "./project";

/**
 * 警報の定義（Project 直下の `alarms`）の純関数。仕様: docs/design/runtime/alarm-stage3-design.md §3
 * 形は schema、限界の順序・deadband・重複はここと Rust（crates/scada-model/src/alarms.rs）の同じ規則。
 * タグの型はタグ一覧があるときだけ（編集のとき）確かめる。
 */

export type AlarmSeverity = "high" | "medium" | "low";
export type AlarmAckMode = "manual" | "autoOnReturn" | "none" | "noneWithSound";
export const ALARM_LIMIT_KEYS = ["hh", "h", "l", "ll"] as const;
export type AlarmLimitKey = (typeof ALARM_LIMIT_KEYS)[number];
export interface AlarmLimit {
  value: number;
  severity: AlarmSeverity;
  message?: string;
}
export type AlarmSource =
  | {
      kind: "threshold";
      tag: string;
      limits: Partial<Record<AlarmLimitKey, AlarmLimit>>;
      deadband?: number;
    }
  | { kind: "bit"; tag: string; activeWhen: boolean };
export interface AlarmDefinition {
  id: string;
  name: string;
  enabled: boolean;
  source: AlarmSource;
  /** bit の定義だけ。しきい値は限界ごとに持つ。 */
  severity?: AlarmSeverity;
  message?: string;
  onDelayMs?: number;
  offDelayMs?: number;
  ackMode?: AlarmAckMode;
}
export interface AlarmSettings {
  blinkUnacked?: boolean;
  definitions: AlarmDefinition[];
}

/** `scada-alarm` の `MAX_DELAY_MS` と同じ。 */
export const MAX_ALARM_DELAY_MS = 600_000;
export const MAX_ALARM_DEFINITIONS = 1000;
export const ALARM_SEVERITIES: readonly [AlarmSeverity, string][] = [
  ["high", "高"],
  ["medium", "中"],
  ["low", "低"],
];
export const ALARM_ACK_MODES: readonly [AlarmAckMode, string][] = [
  ["manual", "手動で確認（既定）"],
  ["autoOnReturn", "復帰で自動確認"],
  ["none", "確認不要"],
  ["noneWithSound", "確認不要（発生時に一度鳴らす）"],
];
const NUMERIC_TYPES = ["i16", "u16", "i32", "u32", "f32", "i64", "u64", "f64"];

/** 定義が空で点滅も既定なら undefined（`alarms` ごと保存しない）。 */
export function normalizeAlarms(
  alarms: AlarmSettings | undefined,
): AlarmSettings | undefined {
  if (!alarms) return undefined;
  if (!alarms.definitions.length && !alarms.blinkUnacked) return undefined;
  const out: AlarmSettings = { definitions: alarms.definitions };
  if (alarms.blinkUnacked) out.blinkUnacked = true;
  return out;
}

/** 構造と値の検査（Rust と同じ規則）。違反は Error。 */
export function validateAlarms(alarms: AlarmSettings | undefined): void {
  if (!alarms) return;
  const ids = new Set<string>(),
    names = new Set<string>();
  for (const definition of alarms.definitions) {
    if (ids.has(definition.id))
      throw new Error("警報の定義の id が重複しています");
    ids.add(definition.id);
    if (names.has(definition.name))
      throw new Error("警報の名前が重複しています");
    names.add(definition.name);
    if (definition.source.kind === "threshold")
      validateLimits(definition.source);
  }
}

function validateLimits(source: Extract<AlarmSource, { kind: "threshold" }>) {
  const [hh, h, l, ll] = ALARM_LIMIT_KEYS.map(
    (key) => source.limits[key]?.value,
  );
  if ([hh, h, l, ll].some((v) => v !== undefined && !Number.isFinite(v)))
    throw new Error("警報の限界の値は有限の数にしてください");
  // i64・u64 のタグでも限界が丸められずに保存・比較されるよう、±(2^53 − 1) に収める。
  if (
    [hh, h, l, ll].some(
      (v) => v !== undefined && Math.abs(v) > Number.MAX_SAFE_INTEGER,
    )
  )
    throw new Error(
      `警報の限界の値は ±${Number.MAX_SAFE_INTEGER} の範囲にしてください`,
    );
  const upper = h ?? hh,
    lower = l ?? ll;
  if (
    (hh !== undefined && h !== undefined && hh < h) ||
    (l !== undefined && ll !== undefined && l < ll) ||
    (upper !== undefined && lower !== undefined && upper <= lower)
  )
    throw new Error("警報の限界は HH ≥ H > L ≥ LL の順にしてください");
  if (
    source.deadband !== undefined &&
    upper !== undefined &&
    lower !== undefined &&
    source.deadband >= upper - lower
  )
    throw new Error(
      "警報の deadband は上の限界と下の限界の差より小さくしてください",
    );
}

/** タグ一覧があるときだけの型の検査。一覧に無いタグは確かめない。 */
export function validateAlarmTagType(
  definition: AlarmDefinition,
  tags: readonly { externalName: string; type: string }[],
): void {
  const tag = tags.find((row) => row.externalName === definition.source.tag);
  if (!tag) return;
  if (definition.source.kind === "bit" && tag.type !== "bit")
    throw new Error("bit の警報には bit 型のタグを指定してください");
  if (
    definition.source.kind === "threshold" &&
    !NUMERIC_TYPES.includes(tag.type)
  )
    throw new Error(
      "しきい値の警報には数値型（i16〜f64）のタグを指定してください",
    );
}

/** 重ならない名前。`base` が空いていればそのまま、使われていれば番号を足す。 */
/**
 * 先頭から `count` 文字（コードポイント）を取る。schema の maxLength と同じ数え方で、
 * サロゲートペアの途中で切らない。
 */
export function leadingChars(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("");
}

export function uniqueAlarmName(
  definitions: readonly AlarmDefinition[],
  base: string,
): string {
  const used = new Set(definitions.map((row) => row.name));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${leadingChars(base, 100 - String(n).length - 1)} ${n}`;
    if (!used.has(name)) return name;
  }
}

/** 追加の既定値。しきい値は H だけ、bit は ON で発生。 */
export function newAlarmDefinition(
  project: Pick<Project, "alarms">,
  kind: AlarmSource["kind"],
  id: string,
): AlarmDefinition {
  const definitions = project.alarms?.definitions ?? [];
  const name = uniqueAlarmName(definitions, "新しい警報");
  return kind === "threshold"
    ? {
        id,
        name,
        enabled: true,
        source: {
          kind,
          tag: "TAG.NAME",
          limits: { h: { value: 100, severity: "medium" } },
        },
      }
    : {
        id,
        name,
        enabled: true,
        source: { kind, tag: "TAG.NAME", activeWhen: true },
        severity: "high",
      };
}
