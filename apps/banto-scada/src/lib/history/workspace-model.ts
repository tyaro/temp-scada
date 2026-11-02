import Ajv2020 from "ajv/dist/2020.js";
import historySchema from "../../../../../crates/scada-historian/schema/history-contract.schema.json";
import { parseHistoryContract, type HistoryQuery } from "../history-contract";
import type { Project } from "../project";
import type { HistorySource } from "./presentation";
import { ownHistoryJson, freezeHistory } from "./owned-json";
import {
  parseTrendDefinitions,
  type TrendDefinition,
} from "../trend-definitions";

/** In-process selection snapshot. Replace the service object to renew it. */
export interface HistoryService {
  source: HistorySource;
  context: unknown;
}
interface HistoryContextFields {
  kind: "historyContext";
  contextId: string;
  projectId: string;
  projectRevision: number;
  series: { seriesId: string; label: string }[];
}
export type HistoryContext = HistoryContextFields &
  ({ version: 1 } | { version: 2; historianNamespace: string });
/** Fresh identity for every explicit open, including the same definition. */
export interface HistoryPreset {
  definitionId: string;
  token: object;
}
const validateContext = new Ajv2020({
  strictNumbers: true,
}).compile<HistoryContext>({
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "kind",
    "contextId",
    "projectId",
    "projectRevision",
    "series",
  ],
  properties: {
    version: { enum: [1, 2] },
    historianNamespace: { $ref: "#/$defs/id" },
    kind: { const: "historyContext" },
    contextId: { $ref: "#/$defs/id" },
    projectId: { type: "string" },
    projectRevision: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    series: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seriesId", "label"],
        properties: {
          seriesId: { $ref: "#/$defs/id" },
          label: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
    },
  },
  oneOf: [
    {
      properties: { version: { const: 1 } },
      not: { required: ["historianNamespace"] },
    },
    { properties: { version: { const: 2 } }, required: ["historianNamespace"] },
  ],
  $defs: { id: historySchema.$defs.id },
});
export type HistoryContextState =
  | { phase: "ready"; context: HistoryContext }
  | { phase: "offline" | "invalid" | "mismatch" };

export function historyContext(
  service: HistoryService | undefined,
  project: Project,
): HistoryContextState {
  if (!service) return { phase: "offline" };
  try {
    const input = ownHistoryJson(service.context, 1024 * 1024);
    if (!validateContext(input)) return { phase: "invalid" };
    const ids = new Set(input.series.map((row) => row.seriesId));
    if (
      ids.size !== input.series.length ||
      input.series.some((row) => !row.label.trim())
    )
      return { phase: "invalid" };
    if (
      input.projectId !== project.manifest.projectId ||
      input.projectRevision !== project.manifest.projectRevision
    )
      return { phase: "mismatch" };
    return { phase: "ready", context: freezeHistory(input) };
  } catch {
    return { phase: "invalid" };
  }
}

export interface HistoryForm {
  selected: string[];
  from: string;
  to: string;
  mode: string;
  points: string;
}
export const newHistoryForm = (): HistoryForm => ({
  selected: [],
  from: "",
  to: "",
  mode: "raw",
  points: "100",
});
export function utcMs(text: string): number | undefined {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text)) return;
  const value = Date.parse(text);
  if (Number.isFinite(value) && new Date(value).toISOString() === text)
    return value;
}
export function historyFormQuery(
  context: HistoryContext,
  form: HistoryForm,
  requestId: string,
): { query: HistoryQuery; issue?: never } | { issue: string; query?: never } {
  const selected = new Set(form.selected);
  if (
    !selected.size ||
    selected.size > 8 ||
    selected.size !== form.selected.length
  )
    return { issue: "履歴系列を1〜8件選択してください" };
  const seriesIds = context.series
    .filter((row) => selected.has(row.seriesId))
    .map((row) => row.seriesId);
  if (seriesIds.length !== selected.size)
    return { issue: "提供された履歴系列を選択してください" };
  const fromMs = utcMs(form.from),
    toMs = utcMs(form.to);
  if (fromMs === undefined || toMs === undefined)
    return {
      issue:
        "開始・終了は実在するUTC時刻を YYYY-MM-DDTHH:mm:ss.SSSZ で入力してください",
    };
  if (toMs <= fromMs || toMs - fromMs > 3_600_000)
    return { issue: "終了を開始より後にし、期間を1時間以内にしてください" };
  if (!/^[1-9]\d{0,3}$/.test(form.points))
    return { issue: "点数は1〜2000の整数を入力してください" };
  const maxPointsPerSeries = Number(form.points);
  if (maxPointsPerSeries > 2000 || maxPointsPerSeries * seriesIds.length > 8000)
    return { issue: "各系列2000点以内、合計8000点以内にしてください" };
  try {
    const query = parseHistoryContract({
      version: 1,
      kind: "query",
      requestId,
      seriesIds,
      fromMs,
      toMs,
      mode: form.mode,
      maxPointsPerSeries,
    });
    if (query.kind !== "query") throw Error("query kind");
    return { query };
  } catch {
    return { issue: "検索条件を確認してください" };
  }
}

/** Resolve a fresh, owned definition; a listing is not proof of retained data. */
export function historyPresetDefinition(
  project: Pick<Project, "trends">,
  context: HistoryContext,
  definitionId: string,
):
  | { definition: TrendDefinition; issue?: never }
  | { issue: string; definition?: never } {
  const input = project.trends?.find((row) => row.id === definitionId);
  if (!input) return { issue: "保存トレンド定義が見つかりません" };
  let definition: TrendDefinition;
  try {
    definition = parseTrendDefinitions({
      version: 1,
      kind: "trendDefinitions",
      definitions: [input],
    }).definitions[0];
  } catch {
    return { issue: "保存トレンド定義を確認できません" };
  }
  if (context.version !== 2)
    return { issue: "この接続は保存Trendの系列対応を提供していません" };
  if (context.historianNamespace !== definition.historianNamespace)
    return { issue: "保存トレンドと接続先のnamespaceが一致しません" };
  const ids = new Set(context.series.map((row) => row.seriesId));
  if (definition.pens.some((pen) => !ids.has(pen.seriesId)))
    return { issue: "保存トレンドの全系列が接続先の一覧にありません" };
  return { definition };
}
export function historyPresetQuery(
  context: HistoryContext,
  definition: TrendDefinition,
  to: string,
  requestId: string,
): { query: HistoryQuery; issue?: never } | { issue: string; query?: never } {
  // Revalidate the declaration and settings at the final query boundary too.
  const resolved = historyPresetDefinition(
    { trends: [definition] },
    context,
    definition.id,
  );
  if (!resolved.definition) return { issue: resolved.issue };
  definition = resolved.definition;
  const toMs = utcMs(to);
  if (toMs === undefined)
    return {
      issue:
        "終了は実在するUTC時刻を YYYY-MM-DDTHH:mm:ss.SSSZ で入力してください",
    };
  const fromMs = toMs - definition.windowMs;
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs))
    return { issue: "検索期間を安全に計算できません" };
  const from = new Date(fromMs);
  if (!Number.isFinite(from.getTime()) || utcMs(from.toISOString()) !== fromMs)
    return { issue: "計算した開始UTCが4桁年の範囲を超えています" };
  try {
    const query = parseHistoryContract({
      version: 1,
      kind: "query",
      requestId,
      seriesIds: definition.pens.map((pen) => pen.seriesId),
      fromMs,
      toMs,
      mode: definition.mode,
      maxPointsPerSeries: definition.maxPointsPerSeries,
    });
    if (query.kind !== "query") throw Error("query kind");
    return { query };
  } catch {
    return { issue: "検索条件を確認してください" };
  }
}
