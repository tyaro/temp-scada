import {
  ProjectFileError,
  type ProjectFileService,
} from "../lib/project-file-service";

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
      ).catch(refusal)) as { status: string; fileId: number; fileName: string };
      if (answer.status === "cancelled") return null;
      return { fileId: answer.fileId, fileName: answer.fileName };
    },
  };
}
