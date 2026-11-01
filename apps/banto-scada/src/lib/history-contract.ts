/** H1 pure contract checks. No storage, transport, recorder or UI is connected. */
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-historian/schema/history-contract.schema.json";

export type HistoryIssue = "accepted" | "schema" | "semantic";
type Source =
  | "real"
  | "computed"
  | "internal"
  | "db"
  | "simulation"
  | "derivedSimulation"
  | "unknown";
interface Identity {
  seriesId: string;
  hubInstanceId: string;
  incarnationId: string;
  externalName: string;
  segmentId: string;
  valueType: "number" | "bool";
  unit: string | null;
  periodMs: number;
  source: Source;
}
interface RecordId {
  sessionId: string;
  sequence: number;
}
interface Sample {
  seriesId: string;
  segmentId: string;
  recordId: RecordId;
  clockEpoch: string;
  sampleTimeMs: number;
  sourceTimeMs: number | null;
  ingestedAtMs: number;
  quality: "good" | "bad" | "stale" | "unknown" | null;
  source: Source | null;
  value: number | boolean | null;
  reason:
    | "bad"
    | "stale"
    | "unknownQuality"
    | "simulationExcluded"
    | "unknownSource"
    | "sourceUnavailable"
    | "unresolved"
    | "identityPending"
    | "missingValue"
    | "nonFinite"
    | "typeMismatch"
    | null;
}
interface Query {
  version: 1;
  kind: "query";
  requestId: string;
  seriesIds: string[];
  fromMs: number;
  toMs: number;
  mode: "raw" | "minmax";
  maxPointsPerSeries: number;
}
interface Batch {
  version: 1;
  kind: "sampleBatch";
  sessionId: string;
  series: Identity[];
  samples: Sample[];
  committedThrough: number | null;
}
interface Coverage {
  fromMs: number;
  toMs: number;
  reason:
    | Exclude<Sample["reason"], null>
    | "unrecorded"
    | "expired"
    | "pendingFlush"
    | "recorderStopped"
    | "samplingMissed"
    | "storageLoss"
    | "unknownCoverage";
}
interface Bin {
  fromMs: number;
  toMs: number;
  min: number | null;
  max: number | null;
  validCount: number;
  invalidCount: number;
  state: "complete" | "partial" | "gap" | "mixedSegment";
  segmentId: string | null;
  source: Source | null;
}
interface SeriesResult {
  seriesId: string;
  status: "ready" | "unknownSeries" | "queryUnavailable";
  segments: Identity[];
  raw: Sample[];
  bins: Bin[];
  coverage: Coverage[];
  watermark: { sessionId: string; committedThrough: number } | null;
}
interface Result {
  version: 1;
  kind: "result";
  query: Query;
  status: "ready" | "partial" | "unavailable";
  snapshotId: string | null;
  series: SeriesResult[];
}
export type HistoryContract = Query | Batch | Result;

// The schema is shared with Rust. Finiteness is an explicit semantic check;
// non-finite JS inputs cannot occur in a parsed JSON document.
const validate = new Ajv2020({
  strictNumbers: false,
  allowUnionTypes: true,
}).compile<HistoryContract>(schema);
const allowedSource = (source: Source | null) =>
  source !== null && ["real", "computed", "internal", "db"].includes(source);
const key = (...parts: string[]) => JSON.stringify(parts);
function finite(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finite);
  if (value !== null && typeof value === "object")
    return Object.values(value).every(finite);
  return true;
}
function query(value: Query) {
  const count = new Set(value.seriesIds).size;
  const width = BigInt(value.toMs) - BigInt(value.fromMs);
  return (
    count === value.seriesIds.length &&
    width > 0n &&
    width <= 3_600_000n &&
    count * value.maxPointsPerSeries <= 8000
  );
}
function identities(values: Identity[]) {
  const bySegment = new Map<string, Identity>();
  const bySeries = new Map<string, string>();
  const byIncarnation = new Map<string, string>();
  for (const value of values) {
    const segment = key(value.seriesId, value.segmentId);
    const incarnation = key(value.hubInstanceId, value.incarnationId);
    if (
      bySegment.has(segment) ||
      (bySeries.has(value.seriesId) &&
        bySeries.get(value.seriesId) !== incarnation) ||
      (byIncarnation.has(incarnation) &&
        byIncarnation.get(incarnation) !== value.seriesId)
    )
      return null;
    bySegment.set(segment, value);
    bySeries.set(value.seriesId, incarnation);
    byIncarnation.set(incarnation, value.seriesId);
  }
  return bySegment;
}
function sample(value: Sample, descriptor: Identity) {
  if (value.source !== null && value.source !== descriptor.source) return false;
  if (value.value !== null)
    return (
      value.quality === "good" &&
      allowedSource(value.source) &&
      value.sourceTimeMs !== null &&
      value.reason === null &&
      (descriptor.valueType === "bool"
        ? typeof value.value === "boolean"
        : typeof value.value === "number" && Number.isFinite(value.value))
    );
  switch (value.reason) {
    case "bad":
      return value.quality === "bad";
    case "stale":
      return value.quality === "stale";
    case "unknownQuality":
      return value.quality === "unknown";
    case "simulationExcluded":
      return (
        value.source === "simulation" || value.source === "derivedSimulation"
      );
    case "unknownSource":
      return value.source === "unknown";
    case "sourceUnavailable":
    case "unresolved":
    case "identityPending":
      return (
        value.quality === null &&
        value.source === null &&
        value.sourceTimeMs === null
      );
    case "missingValue":
    case "nonFinite":
    case "typeMismatch":
      return value.quality === "good" && allowedSource(value.source);
    default:
      return false;
  }
}
function batch(value: Batch) {
  const descriptors = identities(value.series);
  if (!descriptors || new Set(value.series.map((row) => row.seriesId)).size > 8)
    return false;
  const latest = new Map<string, number>();
  let maxSequence = 0;
  for (const row of value.samples) {
    const descriptor = descriptors.get(key(row.seriesId, row.segmentId));
    const sequence = row.recordId.sequence;
    if (
      !descriptor ||
      row.recordId.sessionId !== value.sessionId ||
      !sample(row, descriptor) ||
      (latest.get(row.seriesId) ?? 0) >= sequence
    )
      return false;
    latest.set(row.seriesId, sequence);
    maxSequence = Math.max(maxSequence, sequence);
  }
  return (
    value.committedThrough === null || value.committedThrough <= maxSequence
  );
}
const interval = (
  value: { fromMs: number; toMs: number },
  from: number,
  to: number,
) => from <= value.fromMs && value.fromMs < value.toMs && value.toMs <= to;
function seriesResult(value: SeriesResult, request: Query) {
  const { raw, bins, coverage, segments, watermark } = value;
  if (value.status !== "ready")
    return (
      segments.length === 0 &&
      raw.length === 0 &&
      bins.length === 0 &&
      coverage.length === 0 &&
      watermark === null
    );
  if (
    segments.length === 0 ||
    segments.some((row) => row.seriesId !== value.seriesId)
  )
    return false;
  const descriptors = identities(segments);
  if (!descriptors) return false;
  let end = request.fromMs;
  for (const range of coverage) {
    if (!interval(range, request.fromMs, request.toMs) || range.fromMs < end)
      return false;
    end = range.toMs;
  }
  if (Math.max(raw.length, bins.length) > request.maxPointsPerSeries)
    return false;
  if (request.mode === "raw") {
    if (bins.length) return false;
    const seen = new Set<string>();
    let previous: Sample | undefined;
    for (const row of raw) {
      const descriptor = descriptors.get(key(row.seriesId, row.segmentId));
      const id = key(row.recordId.sessionId, String(row.recordId.sequence));
      const sorted =
        !previous ||
        row.sampleTimeMs > previous.sampleTimeMs ||
        (row.sampleTimeMs === previous.sampleTimeMs &&
          (row.recordId.sessionId > previous.recordId.sessionId ||
            (row.recordId.sessionId === previous.recordId.sessionId &&
              row.recordId.sequence > previous.recordId.sequence)));
      if (
        !descriptor ||
        row.seriesId !== value.seriesId ||
        !sample(row, descriptor) ||
        row.sampleTimeMs < request.fromMs ||
        row.sampleTimeMs >= request.toMs ||
        coverage.some(
          (range) =>
            (range.reason === "expired" || range.reason === "unrecorded") &&
            range.fromMs <= row.sampleTimeMs &&
            row.sampleTimeMs < range.toMs,
        ) ||
        seen.has(id) ||
        !sorted ||
        (watermark !== null &&
          row.recordId.sessionId === watermark.sessionId &&
          row.recordId.sequence > watermark.committedThrough)
      )
        return false;
      previous = row;
      seen.add(id);
    }
    return true;
  }
  if (raw.length || !bins.length) return false;
  end = request.fromMs;
  for (const bin of bins) {
    if (!interval(bin, request.fromMs, request.toMs) || bin.fromMs !== end)
      return false;
    end = bin.toMs;
    const empty = bin.min === null && bin.max === null;
    if (bin.validCount > 0) {
      let coveredThrough = bin.fromMs;
      for (const range of coverage) {
        if (
          (range.reason === "expired" || range.reason === "unrecorded") &&
          range.fromMs <= coveredThrough
        )
          coveredThrough = Math.max(coveredThrough, range.toMs);
      }
      if (coveredThrough >= bin.toMs) return false;
    }
    if (bin.state === "mixedSegment") {
      if (!empty || bin.segmentId !== null || bin.source !== null) return false;
      continue;
    }
    const descriptor =
      bin.segmentId === null
        ? undefined
        : descriptors.get(key(value.seriesId, bin.segmentId));
    if (!descriptor || bin.source !== descriptor.source) return false;
    if (bin.state === "gap") {
      if (bin.validCount !== 0 || !empty) return false;
      continue;
    }
    if (
      !bin.validCount ||
      bin.min === null ||
      bin.max === null ||
      !Number.isFinite(bin.min) ||
      !Number.isFinite(bin.max) ||
      bin.min > bin.max ||
      (bin.validCount === 1 && bin.min !== bin.max) ||
      !allowedSource(bin.source) ||
      (descriptor.valueType === "bool" &&
        (![0, 1].includes(bin.min) || ![0, 1].includes(bin.max))) ||
      (bin.state === "complete" &&
        (bin.invalidCount !== 0 ||
          coverage.some(
            (range) => range.fromMs < bin.toMs && bin.fromMs < range.toMs,
          )))
    )
      return false;
  }
  return end === request.toMs;
}
function result(value: Result) {
  const request = value.query;
  if (!query(request) || value.series.length !== request.seriesIds.length)
    return false;
  if (!identities(value.series.flatMap((row) => row.segments))) return false;
  let unavailable = 0,
    points = 0;
  let grid: Bin[] | undefined;
  for (let i = 0; i < value.series.length; i++) {
    const row = value.series[i];
    if (row.seriesId !== request.seriesIds[i] || !seriesResult(row, request))
      return false;
    if (row.status === "queryUnavailable") unavailable++;
    points += row.raw.length + row.bins.length;
    if (request.mode === "minmax" && row.status === "ready") {
      if (
        grid &&
        (grid.length !== row.bins.length ||
          grid.some(
            (old, index) =>
              old.fromMs !== row.bins[index].fromMs ||
              old.toMs !== row.bins[index].toMs,
          ))
      )
        return false;
      grid = row.bins;
    }
  }
  const status =
    unavailable === value.series.length
      ? "unavailable"
      : unavailable
        ? "partial"
        : "ready";
  return (
    points <= 8000 &&
    value.status === status &&
    (value.snapshotId === null) === (status === "unavailable")
  );
}
function check(value: unknown): HistoryIssue {
  if (!validate(value)) return "schema";
  if (!finite(value)) return "semantic";
  const valid =
    value.kind === "query"
      ? query(value)
      : value.kind === "sampleBatch"
        ? batch(value)
        : result(value);
  return valid ? "accepted" : "semantic";
}

export function validateHistoryContract(input: unknown): HistoryIssue {
  try {
    return check(structuredClone(input));
  } catch {
    return "schema";
  }
}
/** Returns an owned validated document; this is not a service response receiver. */
export function parseHistoryContract(input: unknown): HistoryContract {
  let value: unknown;
  try {
    value = structuredClone(input);
  } catch {
    throw Error("History contract: schema");
  }
  const issue = check(value);
  if (issue !== "accepted") throw Error(`History contract: ${issue}`);
  return value as HistoryContract;
}
