import Ajv2020 from "ajv/dist/2020.js";
import historySchema from "../../../../../crates/scada-historian/schema/history-contract.schema.json";
import { parseHistoryContract, type HistoryQuery } from "../history-contract";
import type { Project } from "../project";
import type { HistorySource } from "./presentation";
import { ownHistoryJson, freezeHistory } from "./owned-json";

/** In-process selection snapshot. Replace the service object to renew it. */
export interface HistoryService {
  source: HistorySource;
  context: unknown;
}
export interface HistoryContext {
  version: 1;
  kind: "historyContext";
  contextId: string;
  projectId: string;
  projectRevision: number;
  series: { seriesId: string; label: string }[];
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
    version: { const: 1 },
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
function utcMs(text: string): number | undefined {
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
