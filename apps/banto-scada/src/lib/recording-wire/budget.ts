import {
  ownMeasuredHistoryJson,
  type HistoryJsonAccounting,
} from "../history/owned-json";
export interface WireBound {
  readonly bytes: number;
  readonly nodes: number;
  readonly depth: number;
}
export const WIRE_LIMITS = Object.freeze({
  request: Object.freeze({ bytes: 256 * 1024, nodes: 8192, depth: 48 }),
  reply: Object.freeze({ bytes: 2 * 1024 * 1024, nodes: 65536, depth: 80 }),
  snapshot: Object.freeze({ bytes: 1024 * 1024, nodes: 32768, depth: 64 }),
  inspectionRequest: Object.freeze({
    bytes: 1024 * 1024,
    nodes: 32768,
    depth: 64,
  }),
  inspectionReply: Object.freeze({
    bytes: 4 * 1024 * 1024,
    nodes: 196608,
    depth: 96,
  }),
});
export function wireProfile(kind: string): {
  limit: WireBound;
  accounting: HistoryJsonAccounting;
} {
  if (kind === "recordingWireCallInspectionRequest")
    return {
      limit: WIRE_LIMITS.inspectionRequest,
      accounting: "wireInspectionRequest",
    };
  if (kind === "recordingWireCallInspectionReply")
    return {
      limit: WIRE_LIMITS.inspectionReply,
      accounting: "wireInspectionReply",
    };
  if (kind.endsWith("Request"))
    return { limit: WIRE_LIMITS.request, accounting: "wireRequest" };
  return { limit: WIRE_LIMITS.reply, accounting: "wireReply" };
}
export function measureWire(
  value: unknown,
  limit: WireBound,
  accounting: HistoryJsonAccounting,
) {
  const measured = ownMeasuredHistoryJson(
    value,
    limit.bytes,
    limit.nodes,
    accounting,
  );
  fits(measured, limit);
  return measured;
}
export function fits(bound: WireBound, limit: WireBound): void {
  if (
    [bound.bytes, bound.nodes, bound.depth].some(
      (n) => !Number.isSafeInteger(n) || n < 0,
    ) ||
    bound.bytes > limit.bytes ||
    bound.nodes > limit.nodes ||
    bound.depth > limit.depth
  )
    throw Error("wire capacity");
}
