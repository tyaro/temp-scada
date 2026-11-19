import type { AssetStore } from "../../lib/image-assets";
import type { Project } from "../../lib/project";
import { readProjectFile } from "../../lib/project-package";
import { unframe, type RawInvoke } from "../project-file";

/**
 * The words and the startup reads of the Runtime window (Runtime mode design
 * §6, §7). Pure except `loadRuntimeProject`, which takes `invoke`.
 */

/** `runtime_alarm_status` (`AlarmDefinitionMatch`, design §6-3). */
export type AlarmDefinitionMatch =
  "notApplied" | "otherProject" | "differs" | "same";

/** The top bar's notice for the alarm definitions; none when they match. */
export function alarmDefinitionNotice(match: unknown): string | null {
  switch (match) {
    case "notApplied":
      return "警報の定義が適用されていません（Editor で適用してください）";
    case "otherProject":
      return "この端末の警報は、別の Project の定義で動いています";
    case "differs":
      return "警報の定義が、この Project と違います";
    case "same":
      return null;
    default:
      return "警報の定義の状態を確かめられません";
  }
}

/** `scada:second-instance` (design §7): any reason gets the same words. */
export const SECOND_INSTANCE_NOTICE =
  "すでに起動しています。別の Project・別の mode で使うときは、いまの窓を閉じてから起動してください";

export interface HubStatus {
  state: string;
  tagCount?: number;
  cause?: string;
}

export interface RuntimeHubView {
  connected: boolean;
  /** Needs Editor to (re)connect once: no input field in Runtime. */
  needsEditor: boolean;
  tagCount: number;
  text: string;
}

export const RECONNECT_IN_EDITOR =
  "Hub の接続先が保存されていないか、キーが使えません。Editor で Hub に接続してから Runtime を使ってください";

/** The answer of `runtime_hub_connect`, or what it threw, in words. */
export function runtimeHubView(
  outcome: { ok: true; status: HubStatus } | { ok: false; error: unknown },
): RuntimeHubView {
  if (outcome.ok) {
    const { status } = outcome;
    const connected = status.state === "connected";
    return {
      connected,
      needsEditor: false,
      tagCount: connected ? (status.tagCount ?? 0) : 0,
      text: connected
        ? `Hub接続済み（タグ ${status.tagCount ?? 0} 件）`
        : `Hub接続: ${status.state}${status.cause ? ` / ${status.cause}` : ""}`,
    };
  }
  const { error } = outcome;
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { reason?: unknown }).reason === "reconnectInEditor"
  )
    return {
      connected: false,
      needsEditor: true,
      tagCount: 0,
      text: RECONNECT_IN_EDITOR,
    };
  return {
    connected: false,
    needsEditor: false,
    tagCount: 0,
    text: `Hub接続に失敗しました${typeof error === "string" ? `（${error}）` : ""}`,
  };
}

/** Why the startup Project is not shown, in words (design §6-1). */
export function projectFailureText(reason: unknown): string {
  switch (reason) {
    case "unreadable":
      return "ファイルを読めません";
    case "invalidFormat":
      return "Project の形式が違います";
    default:
      return "Project を開けません";
  }
}

export type RuntimeProject =
  | {
      status: "opened";
      fileName: string;
      projectDigest: string;
      project: Project;
      store: AssetStore;
    }
  | { status: "failed"; fileName: string; reason: string };

/** Reads the host's startup Project (`runtime_project`) the way Editor reads
 * an opened file (`readProjectFile`): JSON and the package format. */
export async function loadRuntimeProject(
  invoke: RawInvoke,
): Promise<RuntimeProject> {
  let header: any, body: Uint8Array;
  try {
    const answer = await invoke("runtime_project");
    ({ header, body } = unframe(
      answer instanceof ArrayBuffer
        ? new Uint8Array(answer)
        : new Uint8Array(answer as ArrayLike<number>),
    ));
  } catch {
    return { status: "failed", fileName: "", reason: "unavailable" };
  }
  const fileName = typeof header?.fileName === "string" ? header.fileName : "";
  if (header?.status !== "opened")
    return {
      status: "failed",
      fileName,
      reason: String(header?.reason ?? "unavailable"),
    };
  try {
    const { project, store } = await readProjectFile(
      new Blob([body as BlobPart]),
    );
    return {
      status: "opened",
      fileName,
      projectDigest: String(header.projectDigest ?? ""),
      project,
      store,
    };
  } catch {
    return { status: "failed", fileName, reason: "invalidFormat" };
  }
}
