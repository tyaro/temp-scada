import {
  ProjectFileError,
  type AlarmAckResult,
  type AlarmApplyResult,
  type AlarmFeed,
  type AlarmEventRead,
  type ProjectFileService,
} from "../lib/project-file-service";
import type {
  AlarmBuzzerStatus,
  AlarmChange,
  AlarmSnapshot,
} from "../lib/alarm-mirror";
import type { AlarmSettingsView } from "../lib/alarm-settings";
import { listen } from "@tauri-apps/api/event";

/** `invoke` of `@tauri-apps/api/core` with a raw body, passed in so tests can
 * replace it. */
export type RawInvoke = (
  command: string,
  args?: Uint8Array | Record<string, unknown>,
) => Promise<unknown>;

const encoder = new TextEncoder(),
  decoder = new TextDecoder();

/** `[u32 LE: header length][header JSON][body]` (`scada_host::project_file`). */
export function frame(header: unknown, body: Uint8Array): Uint8Array {
  const json = encoder.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + body.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(body, 4 + json.length);
  return out;
}

export function unframe(bytes: Uint8Array): { header: any; body: Uint8Array } {
  if (bytes.length < 4) throw new ProjectFileError("invalid_response");
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0, true);
  if (4 + length > bytes.length) throw new ProjectFileError("invalid_response");
  return {
    header: JSON.parse(decoder.decode(bytes.subarray(4, 4 + length))),
    body: bytes.subarray(4 + length),
  };
}

function refusal(error: unknown): never {
  if (typeof error === "string") throw new ProjectFileError(error);
  throw error;
}

/** The desktop's `project_open` / `project_save` (alarm design §5.5). */
export function nativeProjectFiles(invoke: RawInvoke): ProjectFileService {
  return {
    async open() {
      const answer = await invoke("project_open").catch(refusal);
      const bytes =
        answer instanceof ArrayBuffer
          ? new Uint8Array(answer)
          : new Uint8Array(answer as ArrayLike<number>);
      const { header, body } = unframe(bytes);
      if (header.status === "cancelled") return null;
      return {
        fileId: header.fileId,
        file: new File([body as BlobPart], header.fileName),
      };
    },
    async save({ content, ...header }) {
      const answer = (await invoke(
        "project_save",
        frame(header, content),
      ).catch(refusal)) as {
        status: string;
        fileId: number;
        fileName: string;
        apply: AlarmApplyResult;
      };
      if (answer.status === "cancelled") return null;
      return {
        fileId: answer.fileId,
        fileName: answer.fileName,
        apply: answer.apply,
      };
    },
    async apply(fileId, confirmed, confirmedSwitchFrom) {
      return (await invoke("alarm_apply", {
        fileId,
        confirmed,
        confirmedSwitchFrom: confirmedSwitchFrom ?? null,
      }).catch(refusal)) as AlarmApplyResult;
    },
    alarmFeed: {
      snapshot: () => invoke("alarm_snapshot") as Promise<AlarmSnapshot>,
      ack: async (items) =>
        (await invoke("alarm_ack", {
          items: items.map(({ conditionId, occurrence, recurrence }) => ({
            conditionId,
            occurrence,
            recurrence,
          })),
        }).catch(refusal)) as AlarmAckResult[],
      history: async ({ beforeSeq, fromMs, toMs, kind, limit }) =>
        (await invoke("alarm_history", {
          beforeSeq,
          fromMs,
          toMs,
          kind,
          limit,
        }).catch(refusal)) as AlarmEventRead[],
      silenceBuzzer: async () =>
        (await invoke("alarm_buzzer_silence").catch(
          refusal,
        )) as AlarmBuzzerStatus,
      alarmSettings: async () =>
        (await invoke("alarm_settings_get").catch(
          refusal,
        )) as AlarmSettingsView,
      setAlarmSettings: async (settings) =>
        (await invoke("alarm_settings_set", { settings }).catch(
          refusal,
        )) as AlarmSettingsView,
      importAlarmSound: async () =>
        (await invoke("alarm_sound_import").catch(
          refusal,
        )) as AlarmSettingsView | null,
      resetAlarmSound: async () =>
        (await invoke("alarm_sound_reset").catch(refusal)) as AlarmSettingsView,
      testAlarmSound: async () => {
        await invoke("alarm_sound_test").catch(refusal);
      },
      async subscribe(change, lagged) {
        const offChange = await listen<AlarmChange>("alarm_changed", (event) =>
          change(event.payload),
        );
        try {
          const offLagged = await listen("alarm_changed_lagged", lagged);
          return () => {
            offChange();
            offLagged();
          };
        } catch (error) {
          offChange();
          throw error;
        }
      },
    },
  };
}

/**
 * The alarm host of the Runtime window (Runtime mode design §5, §10-4): the
 * Editor's feed without the Editor-only sound import (`alarm_sound_import`).
 * `alarm_apply` is not part of the feed.
 */
export function runtimeAlarmFeed(invoke: RawInvoke): AlarmFeed {
  const feed = nativeProjectFiles(invoke).alarmFeed!;
  return { ...feed, importAlarmSound: undefined };
}
