/**
 * 時刻だけで値が決まる筋書き（版つきの JSON）の読込と評価（Issue #389）。
 *
 * 形は `docs/design/runtime/scenario-format.md`。Rust の `crates/scada-scenario` と同じ
 * 筋書き・同じ時刻から同じ値を出す（共通の試験ケースは `crates/scada-scenario/tests/cases/`）。
 * このフォルダーはほかのモジュールを import しない（上流へ移すときにそのまま持ち出す）。
 */

export const SCENARIO_FORMAT = "banto-scenario";
export const SCENARIO_VERSION = 1;

export type ScenarioValue = number | boolean;

export interface ScenarioWave {
  amplitude: number;
  periodSec: number;
  shiftSec: number;
}

export interface NumberSignal {
  kind: "number";
  base: number;
  waves: ScenarioWave[];
  /** 周期の中の秒と値の点列。同じ秒の点を続けると段差になる。 */
  points: [number, number][];
  rampPerHour: number;
  /** ランプの分を、この値で割った余りにする（0 は割らない）。 */
  rampWrap: number;
  /** 小数の桁数（省くと丸めない）。 */
  digits: number | null;
  shiftSec: number;
}

export interface BitSignal {
  kind: "bit";
  value: boolean;
  /** ON・OFF の周期（0 は固定の `value`）。 */
  periodSec: number;
  onSec: number;
  shiftSec: number;
}

export type ScenarioSignal = NumberSignal | BitSignal;

export interface ScenarioEvent {
  atSec: number;
  durationSec: number;
  values: Record<string, ScenarioValue>;
}

export interface Scenario {
  cycleSec: number;
  epochSec: number;
  freezeAtSec: number | null;
  signals: Record<string, ScenarioSignal>;
  events: ScenarioEvent[];
}

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function onlyKeys(object: Json, where: string, allowed: readonly string[]) {
  for (const key of Object.keys(object))
    if (!allowed.includes(key))
      throw new ScenarioError(`${where}: 知らない項目 ${key}`);
}

function finite(object: Json, key: string, where: string, fallback?: number) {
  const value = object[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ScenarioError(`${where}.${key}: 有限の数が要る`);
  return value;
}

function positive(object: Json, key: string, where: string) {
  const value = finite(object, key, where);
  if (!(value > 0)) throw new ScenarioError(`${where}.${key}: 正の数が要る`);
  return value;
}

const NUMBER_KEYS = [
  "kind",
  "like",
  "base",
  "waves",
  "points",
  "rampPerHour",
  "rampWrap",
  "digits",
  "shiftSec",
] as const;
const BIT_KEYS = [
  "kind",
  "like",
  "value",
  "periodSec",
  "onSec",
  "shiftSec",
] as const;

function readNumber(raw: Json, where: string, cycleSec: number): NumberSignal {
  onlyKeys(raw, where, NUMBER_KEYS);
  const waves = raw.waves ?? [];
  if (!Array.isArray(waves))
    throw new ScenarioError(`${where}.waves: 配列が要る`);
  const points = raw.points ?? [];
  if (!Array.isArray(points))
    throw new ScenarioError(`${where}.points: 配列が要る`);
  const pairs = points.map((point, index): [number, number] => {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !point.every((n) => typeof n === "number" && Number.isFinite(n))
    )
      throw new ScenarioError(`${where}.points[${index}]: [秒, 値] が要る`);
    return [point[0], point[1]];
  });
  pairs.forEach(([sec], index) => {
    if (sec < 0 || sec > cycleSec)
      throw new ScenarioError(`${where}.points[${index}]: 秒は 0〜周期`);
    if (index > 0 && sec < pairs[index - 1][0])
      throw new ScenarioError(`${where}.points[${index}]: 秒が戻っている`);
  });
  const digits = raw.digits;
  if (
    digits !== undefined &&
    (typeof digits !== "number" ||
      !Number.isInteger(digits) ||
      digits < 0 ||
      digits > 9)
  )
    throw new ScenarioError(`${where}.digits: 0〜9 の整数が要る`);
  const rampWrap = finite(raw, "rampWrap", where, 0);
  if (rampWrap < 0) throw new ScenarioError(`${where}.rampWrap: 0 以上が要る`);
  return {
    kind: "number",
    base: finite(raw, "base", where, 0),
    waves: waves.map((wave, index) => {
      const at = `${where}.waves[${index}]`;
      if (!isObject(wave)) throw new ScenarioError(`${at}: 物が要る`);
      onlyKeys(wave, at, ["amplitude", "periodSec", "shiftSec"]);
      return {
        amplitude: finite(wave, "amplitude", at),
        periodSec: positive(wave, "periodSec", at),
        shiftSec: finite(wave, "shiftSec", at, 0),
      };
    }),
    points: pairs,
    rampPerHour: finite(raw, "rampPerHour", where, 0),
    rampWrap,
    digits: (digits as number | undefined) ?? null,
    shiftSec: finite(raw, "shiftSec", where, 0),
  };
}

function readBit(raw: Json, where: string): BitSignal {
  onlyKeys(raw, where, BIT_KEYS);
  const value = raw.value ?? false;
  if (typeof value !== "boolean")
    throw new ScenarioError(`${where}.value: true・false が要る`);
  const periodSec = finite(raw, "periodSec", where, 0);
  if (periodSec < 0)
    throw new ScenarioError(`${where}.periodSec: 0 以上が要る`);
  const onSec = finite(raw, "onSec", where, 0);
  if (onSec < 0 || (periodSec > 0 && onSec > periodSec))
    throw new ScenarioError(`${where}.onSec: 0〜periodSec`);
  return {
    kind: "bit",
    value,
    periodSec,
    onSec,
    shiftSec: finite(raw, "shiftSec", where, 0),
  };
}

/** `like` をたどり、元の信号の項目へ自分の項目を重ねた生の JSON を返す。 */
function resolveLike(
  raws: Json,
  name: string,
  trail: readonly string[] = [],
): Json {
  const raw = raws[name];
  if (!isObject(raw)) throw new ScenarioError(`signals.${name}: 物が要る`);
  if (raw.like === undefined) return raw;
  if (typeof raw.like !== "string" || !(raw.like in raws))
    throw new ScenarioError(`signals.${name}.like: 無い信号`);
  if (trail.includes(raw.like))
    throw new ScenarioError(`signals.${name}.like: 循環している`);
  const base = resolveLike(raws, raw.like, [...trail, name]);
  if (raw.kind !== undefined && raw.kind !== base.kind)
    throw new ScenarioError(`signals.${name}.kind: like と種類が違う`);
  const { like: _like, ...own } = raw;
  const { like: _baseLike, ...inherited } = base;
  return { ...inherited, ...own };
}

/** 筋書きの JSON を読み、形を確かめる。誤りは `ScenarioError`。 */
export function parseScenario(json: unknown): Scenario {
  if (!isObject(json)) throw new ScenarioError("筋書き: 物が要る");
  onlyKeys(json, "筋書き", [
    "format",
    "version",
    "cycleSec",
    "epochSec",
    "freezeAtSec",
    "signals",
    "events",
  ]);
  if (json.format !== SCENARIO_FORMAT)
    throw new ScenarioError(`format: "${SCENARIO_FORMAT}" が要る`);
  if (json.version !== SCENARIO_VERSION)
    throw new ScenarioError(`version: ${SCENARIO_VERSION} だけを読める`);
  const cycleSec = positive(json, "cycleSec", "筋書き");
  const epochSec = finite(json, "epochSec", "筋書き", 0);
  let freezeAtSec: number | null = null;
  if (json.freezeAtSec !== undefined) {
    freezeAtSec = finite(json, "freezeAtSec", "筋書き");
    if (freezeAtSec < 0 || freezeAtSec >= cycleSec)
      throw new ScenarioError("freezeAtSec: 0 以上・周期未満");
  }
  if (!isObject(json.signals)) throw new ScenarioError("signals: 物が要る");
  const raws = json.signals;
  const signals: Record<string, ScenarioSignal> = {};
  for (const name of Object.keys(raws)) {
    if (name === "") throw new ScenarioError("signals: 空の名前");
    const raw = resolveLike(raws, name);
    const where = `signals.${name}`;
    if (raw.kind === "number") signals[name] = readNumber(raw, where, cycleSec);
    else if (raw.kind === "bit") signals[name] = readBit(raw, where);
    else throw new ScenarioError(`${where}.kind: "number"・"bit" が要る`);
  }
  const rawEvents = json.events ?? [];
  if (!Array.isArray(rawEvents)) throw new ScenarioError("events: 配列が要る");
  const events = rawEvents.map((event, index): ScenarioEvent => {
    const where = `events[${index}]`;
    if (!isObject(event)) throw new ScenarioError(`${where}: 物が要る`);
    onlyKeys(event, where, ["atSec", "durationSec", "values"]);
    const atSec = finite(event, "atSec", where);
    if (atSec < 0 || atSec >= cycleSec)
      throw new ScenarioError(`${where}.atSec: 0 以上・周期未満`);
    const durationSec = positive(event, "durationSec", where);
    if (durationSec > cycleSec)
      throw new ScenarioError(`${where}.durationSec: 周期以下`);
    if (!isObject(event.values))
      throw new ScenarioError(`${where}.values: 物が要る`);
    const values: Record<string, ScenarioValue> = {};
    for (const [name, value] of Object.entries(event.values)) {
      const signal = signals[name];
      if (!signal) throw new ScenarioError(`${where}.values.${name}: 無い信号`);
      const ok =
        signal.kind === "bit"
          ? typeof value === "boolean"
          : typeof value === "number" && Number.isFinite(value);
      if (!ok)
        throw new ScenarioError(`${where}.values.${name}: 信号の種類と違う値`);
      values[name] = value as ScenarioValue;
    }
    return { atSec, durationSec, values };
  });
  return { cycleSec, epochSec, freezeAtSec, signals, events };
}

/** 負にならない余り（Rust 側と同じ手順）。 */
function modulo(value: number, divisor: number): number {
  const rest = value % divisor;
  return rest < 0 ? rest + divisor : rest;
}

/** 0.5 を 0 から遠い方へ丸める（Rust の `f64::round` と同じ）。 */
function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  // 正の数では Math.round の同点（+∞ 側）と 0 から遠い方が一致する。
  const rounded = Math.round(Math.abs(value) * scale) / scale;
  return value < 0 ? -rounded : rounded;
}

function piecewise(points: readonly [number, number][], phase: number): number {
  if (points.length === 0) return 0;
  if (phase < points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t0, v0] = points[i - 1],
      [t1, v1] = points[i];
    if (phase < t1) return v0 + ((v1 - v0) * (phase - t0)) / (t1 - t0);
  }
  return points[points.length - 1][1];
}

function evaluateNumber(
  signal: NumberSignal,
  scenario: Scenario,
  tSec: number,
): number {
  const local = tSec - signal.shiftSec;
  let value = signal.base;
  for (const wave of signal.waves)
    value +=
      wave.amplitude *
      Math.sin(
        (2 * Math.PI * modulo(local - wave.shiftSec, wave.periodSec)) /
          wave.periodSec,
      );
  value += piecewise(
    signal.points,
    modulo(local - scenario.epochSec, scenario.cycleSec),
  );
  if (signal.rampPerHour !== 0) {
    const ramp = (signal.rampPerHour * (tSec - scenario.epochSec)) / 3600;
    value += signal.rampWrap > 0 ? modulo(ramp, signal.rampWrap) : ramp;
  }
  return signal.digits === null ? value : roundTo(value, signal.digits);
}

function evaluateBit(signal: BitSignal, tSec: number): boolean {
  if (signal.periodSec === 0) return signal.value;
  return modulo(tSec - signal.shiftSec, signal.periodSec) < signal.onSec;
}

/** 周期の中の秒（0 以上・周期未満）。 */
export function scenarioPhase(scenario: Scenario, tSec: number): number {
  return modulo(tSec - scenario.epochSec, scenario.cycleSec);
}

/** 時刻 `tSec`（UNIX 秒）の全信号の値。同じ筋書きと時刻には同じ値を返す。 */
export function evaluateScenario(
  scenario: Scenario,
  tSec: number,
): Record<string, ScenarioValue> {
  const values: Record<string, ScenarioValue> = {};
  for (const [name, signal] of Object.entries(scenario.signals))
    values[name] =
      signal.kind === "number"
        ? evaluateNumber(signal, scenario, tSec)
        : evaluateBit(signal, tSec);
  const phase = scenarioPhase(scenario, tSec);
  // 後の出来事ほど優先する。
  for (const event of scenario.events)
    if (modulo(phase - event.atSec, scenario.cycleSec) < event.durationSec)
      Object.assign(values, event.values);
  return values;
}

/**
 * 筋書きを止める時刻（UNIX 秒）。`atSec` を省くと筋書きの `freezeAtSec`、どちらも無ければ
 * `null`（止めない）。基準は `epochSec` から周期の中の `atSec` 秒。
 */
export function frozenTimeSec(
  scenario: Scenario,
  atSec?: number,
): number | null {
  const at = atSec ?? scenario.freezeAtSec;
  return at === null ? null : scenario.epochSec + at;
}
