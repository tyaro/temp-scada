// Independent test oracle for the model's request-derived retained payload accounting.
import { ownMeasuredHistoryJson } from "../history/owned-json";
export const modelBytes = (v: unknown) =>
  ownMeasuredHistoryJson(v, 4 * 1024 * 1024, 196608, "wireInspectionReply")
    .bytes;
export function modelLifetimeBytes(q: any): number {
  const a = q.action;
  const request =
    a.kind === "preflight"
      ? {
          version: 1,
          kind: "recordingOperationRequest",
          operationId: "r".repeat(64),
          stage: "preflight",
          change: a.change,
        }
      : a.kind === "reconcile"
        ? a.reconciliation
        : a.kind === "discard"
          ? null
          : a.operation;
  const h = request ? modelBytes(request) : 0;
  const reply = modelBytes(q) + h + 65536;
  const completion = request ? (a.kind === "reconcile" ? 2 * h : h) + 65536 : 0;
  return (
    modelBytes(q) + 2 * reply + completion + (a.kind === "reconcile" ? 256 : 0)
  );
}
