/** H4c1 display definitions only. No Project, recording plan or service binding. */
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/trend-definition.schema.json";
import historySchema from "../../../../crates/scada-historian/schema/history-contract.schema.json";
import { ownHistoryJson, freezeHistory } from "./history/owned-json";

export interface TrendPen {
  readonly id: string;
  readonly seriesId: string;
  readonly label?: string;
  readonly color: string;
}
export interface TrendDefinition {
  readonly id: string;
  readonly name: string;
  readonly historianNamespace: string;
  readonly pens: readonly TrendPen[];
  readonly windowMs: number;
  readonly mode: "raw" | "minmax";
  readonly maxPointsPerSeries: number;
}
export interface TrendDefinitions {
  readonly version: 1;
  readonly kind: "trendDefinitions";
  readonly definitions: readonly TrendDefinition[];
}
export const MAX_TREND_JSON_BYTES = 1024 * 1024;
// The external ID definition is bundled locally. No asynchronous/network loader.
const validateSchema = new Ajv2020({
  strictNumbers: true,
  allowUnionTypes: true,
})
  .addSchema(historySchema)
  .compile<TrendDefinitions>(schema);

/** Unicode White_Space plus FEFF, explicitly shared with native; no trim(). */
function blank(text: string): boolean {
  return /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$/.test(
    text,
  );
}
function scalar(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
/** Run only on the bounded owned plain JSON, including keys before schema. */
function scalarJson(value: unknown): boolean {
  if (typeof value === "string") return scalar(value);
  if (value === null || typeof value !== "object") return true;
  return Object.entries(value).every(
    ([key, child]) => scalar(key) && scalarJson(child),
  );
}
function check(input: unknown): TrendDefinitions {
  // ownHistoryJson uses JSON.stringify numeric spelling. All accepted numeric
  // fields are small integers, so this matches native's integer-normalized size.
  const value = ownHistoryJson(input, MAX_TREND_JSON_BYTES);
  if (!scalarJson(value) || !validateSchema(value)) throw Error("invalid");
  const ids = new Set<string>();
  for (const row of value.definitions) {
    if (
      ids.has(row.id) ||
      blank(row.name) ||
      row.pens.length * row.maxPointsPerSeries > 8000
    )
      throw Error("invalid");
    ids.add(row.id);
    const pens = new Set<string>(),
      series = new Set<string>();
    for (const pen of row.pens) {
      if (
        pens.has(pen.id) ||
        series.has(pen.seriesId) ||
        (pen.label !== undefined && blank(pen.label))
      )
        throw Error("invalid");
      pens.add(pen.id);
      series.add(pen.seriesId);
    }
  }
  return freezeHistory(value);
}
/** A new frozen snapshot; preserves strings, colors and order without trimming. */
export function parseTrendDefinitions(input: unknown): TrendDefinitions {
  try {
    return check(input);
  } catch {
    throw Error("Trend definitions: invalid");
  }
}
/** Acceptance, not proof that namespace/series exists or is authorized. */
export function validateTrendDefinitions(input: unknown): boolean {
  try {
    check(input);
    return true;
  } catch {
    return false;
  }
}
