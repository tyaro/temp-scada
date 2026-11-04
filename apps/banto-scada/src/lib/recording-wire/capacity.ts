/** Upper bounds, not fabricated schema-valid snapshots or execution evidence. */
import type { RecordingWireRequest } from "./types";
import { WIRE_LIMITS, measureWire, fits, type WireBound } from "./budget";
// All closed reply fields outside request/payload use fewer than 1KiB/32 nodes.
// Reserve 64KiB/4096 nodes for that fixed structure, including maximum IDs/errors.
const ENVELOPE: WireBound = Object.freeze({
  bytes: 64 * 1024,
  nodes: 4096,
  depth: 3,
});
// Legacy operation results use compact counting. At most 3x for control escapes,
// plus 21 per node bounds number1byte -> conservative24. Legacy limits stay fixed.
export const WIRE_OPERATION_RESULT_UPPER: WireBound = Object.freeze({
  bytes: 3 * 256 * 1024 + 21 * 8192,
  nodes: 8192,
  depth: 32,
});
const DELIVERY: WireBound = Object.freeze({
  bytes: 512 * 1024,
  nodes: 16384,
  depth: 48,
});
export interface WireReplyCapacity {
  readonly reply: WireBound;
  readonly callInspection: WireBound | null;
}
export function inspectionUpper(): WireBound {
  return Object.freeze({
    bytes:
      WIRE_LIMITS.inspectionRequest.bytes +
      WIRE_LIMITS.reply.bytes +
      ENVELOPE.bytes,
    nodes:
      WIRE_LIMITS.inspectionRequest.nodes +
      WIRE_LIMITS.reply.nodes +
      ENVELOPE.nodes,
    depth: Math.max(
      WIRE_LIMITS.inspectionRequest.depth + 1,
      WIRE_LIMITS.reply.depth + 2,
      ENVELOPE.depth,
    ),
  });
}
/** Only bounded, schema/semantic-validated requests. Never calls a public parser. */
export function replyCapacity(
  request: RecordingWireRequest,
): WireReplyCapacity {
  if (request.kind === "recordingWireCallInspectionRequest")
    return Object.freeze({ reply: inspectionUpper(), callInspection: null });
  const size = measureWire(request, WIRE_LIMITS.request, "wireRequest");
  let payload: WireBound = { bytes: 0, nodes: 0, depth: 0 };
  if (request.kind === "recordingWireObservationRequest")
    payload =
      request.target.kind === "operation"
        ? WIRE_OPERATION_RESULT_UPPER
        : DELIVERY;
  if (
    request.kind === "recordingWireAttachRequest" ||
    (request.kind === "recordingWireControlRequest" &&
      request.action === "snapshot")
  )
    payload = WIRE_LIMITS.snapshot;
  const reply = Object.freeze({
    bytes: size.bytes + payload.bytes + ENVELOPE.bytes,
    nodes: size.nodes + payload.nodes + ENVELOPE.nodes,
    depth: Math.max(size.depth + 1, payload.depth + 2, ENVELOPE.depth),
  });
  // Observation has its dedicated read-only terminal protocol; it is deliberately
  // excluded from CallInspection.original, just like CallInspection itself.
  if (request.kind !== "recordingWireObservationRequest") {
    measureWire(
      {
        version: 1,
        kind: "recordingWireCallInspectionRequest",
        scope: request.scope,
        callInspectionId: "r".repeat(64),
        original: request,
      },
      WIRE_LIMITS.inspectionRequest,
      "wireInspectionRequest",
    );
    return Object.freeze({ reply, callInspection: inspectionUpper() });
  }
  return Object.freeze({ reply, callInspection: null });
}
export function checkCapacity(
  request: RecordingWireRequest,
  limits: { reply?: WireBound; inspectionReply?: WireBound } = {},
): WireReplyCapacity {
  const upper = replyCapacity(request);
  fits(
    upper.reply,
    request.kind === "recordingWireCallInspectionRequest"
      ? (limits.inspectionReply ?? WIRE_LIMITS.inspectionReply)
      : (limits.reply ?? WIRE_LIMITS.reply),
  );
  if (upper.callInspection)
    fits(
      upper.callInspection,
      limits.inspectionReply ?? WIRE_LIMITS.inspectionReply,
    );
  return upper;
}
