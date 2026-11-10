/**
 * The workflow a new page takes over from the host (product-owner design C5
 * §7.2 "workflowの引継ぎ"): the reserved change and the admissions the gate
 * recorded with their stored replies. Anything malformed is `null`: the page
 * then only shows that earlier work exists.
 */
import {
  parseRecordingChangeRequest,
  type RecordingChangeRequest,
} from "../recording-operations-contract";
import {
  parseRecordingAdmissionReply,
  parseRecordingAdmissionRequest,
  type RecordingAdmissionReply,
  type RecordingAdmissionRequest,
} from "../recording-admission-contract";
import type { RecordingWireScope } from "../recording-wire-contract";
import { sameOwnedJson } from "../json-equality";
import { freezeHistory } from "../history/owned-json";

export interface RecordingWorkflowResumption {
  readonly change: RecordingChangeRequest;
  /** In execution order, at most one per stage. Empty: reserved only. */
  readonly admissions: readonly Readonly<{
    request: RecordingAdmissionRequest;
    reply: RecordingAdmissionReply;
  }>[];
}

const own = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

/** The change an admission's action carries. */
function changeOf(request: RecordingAdmissionRequest): RecordingChangeRequest {
  const action = request.action;
  switch (action.kind) {
    case "preflight":
    case "discard":
      return action.change;
    case "pauseJoin":
    case "apply":
      return action.operation.change;
    case "reconcile":
      return action.reconciliation.operation.change;
  }
}

/** `{"state": "held", ...}` of `recording_workflow_resumption`, or `null`. */
export function parseRecordingWorkflowResumption(
  input: unknown,
  scope: RecordingWireScope,
): RecordingWorkflowResumption | null {
  try {
    if (own(input, "state") !== "held") return null;
    const change = parseRecordingChangeRequest(own(input, "change"));
    if (!sameOwnedJson(change.context, scope.context)) return null;
    const raw = own(input, "admissions");
    if (!Array.isArray(raw) || raw.length > 5) return null;
    const stages = new Set<string>();
    const admissions = raw.map((entry) => {
      const request = parseRecordingAdmissionRequest(own(entry, "request"));
      const reply = parseRecordingAdmissionReply(own(entry, "reply"));
      if (
        stages.has(request.action.kind) ||
        request.ownerRef !== scope.ownerRef ||
        !sameOwnedJson(request.context, scope.context) ||
        !sameOwnedJson(reply.request, request) ||
        !sameOwnedJson(changeOf(request), change) ||
        reply.outcome.kind === "completedDiscard"
      )
        throw Error("invalid admission");
      stages.add(request.action.kind);
      return { request, reply };
    });
    return freezeHistory({ change, admissions }) as RecordingWorkflowResumption;
  } catch {
    return null;
  }
}
