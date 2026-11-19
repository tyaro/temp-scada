import type { StatusBadgeVariant } from "@banto/ui";
import {
  parseRecordingInspectionRequest,
  parseRecordingInspectionResponse,
  parseRecordingManagementContext,
} from "../../lib/recording-management-contract";
import type { RecordingManagementService } from "../../lib/recording-management/service";
import {
  inspectedAtLabel,
  recordingSummary,
  type RecordingSummary,
} from "../../lib/recording-management/summary";

/**
 * The recording state of the Runtime's top bar (Runtime mode design §6-4,
 * §8, §10-3 案 A): one `recording_status` of the startup Project's context,
 * shown read-only. Starting, resuming and stopping stay in Editor.
 */
export type RuntimeRecordingView =
  | Readonly<{ state: "signedOut" }>
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "unavailable" }>
  | Readonly<{
      state: "observed";
      summary: RecordingSummary;
      inspectedAtMs: number;
    }>;

/** The host's error kind of a refusal (`unauthorized`, `forbidden`, ...). */
function errorKind(error: unknown): string | undefined {
  if (error !== null && typeof error === "object") {
    const kind = Object.getOwnPropertyDescriptor(error, "kind")?.value;
    if (typeof kind === "string") return kind;
  }
  return undefined;
}

/** A refusal for want of a session or a role reads as "sign in", not as a fault. */
export function recordingFailureView(error: unknown): RuntimeRecordingView {
  const kind = errorKind(error);
  return Object.freeze({
    state:
      kind === "unauthorized" || kind === "forbidden"
        ? "signedOut"
        : "unavailable",
  });
}

const INSPECTION_DEADLINE_MS = 10_000;

/** One inspection through the service's `inspect`; never throws. */
export async function inspectRuntimeRecording(
  service: RecordingManagementService,
  requestId: string,
  now: () => number = Date.now,
): Promise<RuntimeRecordingView> {
  let input: unknown;
  let request;
  try {
    request = parseRecordingInspectionRequest({
      version: 1,
      kind: "recordingInspectionRequest",
      requestId,
      context: parseRecordingManagementContext(service.context),
    });
  } catch {
    return Object.freeze({ state: "unavailable" });
  }
  try {
    input = await service.inspect(request, {
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + INSPECTION_DEADLINE_MS,
    });
  } catch (error) {
    return recordingFailureView(error);
  }
  try {
    const response = parseRecordingInspectionResponse(input);
    if (response.request.requestId !== requestId) throw Error("mismatch");
    return Object.freeze({
      state: "observed",
      summary: recordingSummary(response),
      inspectedAtMs: now(),
    });
  } catch {
    return Object.freeze({ state: "unavailable" });
  }
}

export interface RuntimeRecordingBadge {
  readonly label: string;
  readonly variant: StatusBadgeVariant;
  readonly title: string;
  /** Shown next to the badge while not recording: where recording starts. */
  readonly note?: string;
}

/** Recording runs in the process that started it, and only Editor starts it
 * (design §8): not recording here means not recorded while this runs. */
export const RECORDING_IN_EDITOR_NOTE =
  "Runtime の運転中は記録されません。記録は Editor で開始します";
export const RECORDING_CHECK_IN_EDITOR_NOTE = "記録の確認は Editor で行います";

export function runtimeRecordingBadge(
  view: RuntimeRecordingView,
): RuntimeRecordingBadge {
  switch (view.state) {
    case "signedOut":
      return {
        label: "記録: ログインが必要",
        variant: "neutral",
        title: "記録の状態を見るにはログインしてください",
      };
    case "loading":
      return { label: "記録: 確認中", variant: "neutral", title: "照会中" };
    case "unavailable":
      return {
        label: "記録: 確認できません",
        variant: "warning",
        title: "記録の状態を照会できませんでした。クリックで再照会します",
      };
    case "observed": {
      const { summary } = view;
      return {
        label: summary.label,
        variant: summary.variant,
        title: `${inspectedAtLabel(view.inspectedAtMs)} 時点の状態です。クリックで再照会します`,
        ...(summary.state === "recording"
          ? {}
          : summary.state === "attention" || summary.state === "unknown"
            ? { note: RECORDING_CHECK_IN_EDITOR_NOTE }
            : { note: RECORDING_IN_EDITOR_NOTE }),
      };
    }
  }
}
