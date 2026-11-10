// The recording registry commands of the desktop host (product-owner design
// C5 §7.2). Each command answers `{seq, reply}` (the reply and the desktop
// session generation it was produced under) or rejects with `{kind, ...}`.
// This file only calls and classifies; the port decides what an answer means.
import type { PortHostRefusal } from "../../lib/recording-async/port";
import type { RecordingWireScope } from "../../lib/recording-wire-contract";
import { parseRecordingWireAttachRequest } from "../../lib/recording-wire-contract";
import {
  parseRecordingWorkflowResumption,
  type RecordingWorkflowResumption,
} from "../../lib/recording-async/resumption";

export type RecordingInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** The registry commands the port calls. */
export type RecordingCommand =
  | "recording_workflow_reserve"
  | "recording_workflow_lease"
  | "recording_workflow_resumption"
  | "recording_lease"
  | "recording_admission"
  | "recording_admission_inspection"
  | "recording_observation"
  | "recording_cancel"
  | "recording_call_inspection"
  | "recording_attach"
  | "recording_control";

/** One physical call's answer. */
export type CommandAnswer = Readonly<
  | { kind: "returned"; seq: number; reply: unknown }
  | { kind: "refused"; refusal: PortHostRefusal }
  | { kind: "failed" }
>;

const own = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

const PLAIN = new Set([
  "invalidRequest",
  "unauthorized",
  "forbidden",
  "authUnavailable",
  "invalidInput",
  "protocolViolation",
  "capacity",
  "busy",
  "expired",
  "closed",
]);

/** A host `{kind}` rejection, or `null` for anything else (an IPC failure). */
export function parseHostRefusal(error: unknown): PortHostRefusal | null {
  const kind = own(error, "kind");
  if (typeof kind !== "string") return null;
  if (kind === "recordingUnavailable") {
    const reason = own(error, "reason");
    return typeof reason === "string" ? Object.freeze({ kind, reason }) : null;
  }
  if (kind === "phase") {
    const phase = own(error, "phase");
    return typeof phase === "string" ? Object.freeze({ kind, phase }) : null;
  }
  return PLAIN.has(kind) ? (Object.freeze({ kind }) as PortHostRefusal) : null;
}

/** Calls one command. Never rejects: a malformed answer is `failed`. */
export async function callRecording(
  invoke: RecordingInvoke,
  command: RecordingCommand,
  args: Record<string, unknown>,
): Promise<CommandAnswer> {
  let value: unknown;
  try {
    value = await invoke(command, args);
  } catch (error) {
    const refusal = parseHostRefusal(error);
    return Object.freeze(
      refusal ? { kind: "refused", refusal } : { kind: "failed" },
    );
  }
  const seq = own(value, "seq");
  if (
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    own(value, "reply") === undefined
  )
    return Object.freeze({ kind: "failed" });
  return Object.freeze({ kind: "returned", seq, reply: own(value, "reply") });
}

/** The workflow a new page takes over, with the generation it was read under. */
export type ResumedWorkflow = Readonly<{
  seq: number;
  workflow: RecordingWorkflowResumption;
}>;

/**
 * `recording_workflow_resumption`. Anything but the caller's own held
 * workflow is `null`: a failed read only leaves the earlier work uncontinued.
 */
export async function readResumption(
  invoke: RecordingInvoke,
  scope: RecordingWireScope,
): Promise<ResumedWorkflow | null> {
  const answer = await callRecording(
    invoke,
    "recording_workflow_resumption",
    {},
  );
  if (answer.kind !== "returned") return null;
  const workflow = parseRecordingWorkflowResumption(answer.reply, scope);
  return workflow && Object.freeze({ seq: answer.seq, workflow });
}

/** `recording_slot`: the installed root's scope, or why there is none. */
export type SlotAnswer = Readonly<
  | { state: "installed"; generation: number; scope: RecordingWireScope }
  | { state: "empty"; reason: string }
  | { state: "unknown" }
>;

export async function readSlot(invoke: RecordingInvoke): Promise<SlotAnswer> {
  let value: unknown;
  try {
    value = await invoke("recording_slot");
  } catch {
    return Object.freeze({ state: "unknown" });
  }
  const state = own(value, "state");
  if (state === "empty") {
    const reason = own(value, "reason");
    return Object.freeze({
      state,
      reason: typeof reason === "string" ? reason : "unknown",
    });
  }
  const generation = own(value, "generation");
  if (
    state !== "installed" ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    return Object.freeze({ state: "unknown" });
  try {
    // The wire parser owns, freezes and validates the scope.
    const scope = parseRecordingWireAttachRequest({
      version: 1,
      kind: "recordingWireAttachRequest",
      scope: own(value, "scope"),
      attachId: "slot",
      afterRevision: null,
    }).scope;
    return Object.freeze({ state, generation, scope });
  } catch {
    return Object.freeze({ state: "unknown" });
  }
}
