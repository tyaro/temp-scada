import { describe, expect, it } from "vitest";
import {
  frame,
  nativeProjectFiles,
  unframe,
  type RawInvoke,
} from "./project-file";
import { ProjectFileError } from "../lib/project-file-service";

const encoder = new TextEncoder();

describe("nativeProjectFiles", () => {
  it("frames the save request as the host reads it", async () => {
    const calls: { command: string; args: unknown }[] = [];
    const invoke: RawInvoke = async (command, args) => {
      calls.push({ command, args });
      return {
        status: "saved",
        fileId: 4,
        fileName: "plant.json",
        apply: null,
      };
    };
    const saved = await nativeProjectFiles(invoke).save({
      fileId: 3,
      format: "json",
      name: "工程",
      saveAs: false,
      content: encoder.encode("{}"),
    });
    expect(saved).toEqual({ fileId: 4, fileName: "plant.json" });
    expect(calls[0].command).toBe("project_save");
    const { header, body } = unframe(calls[0].args as Uint8Array);
    expect(header).toEqual({
      fileId: 3,
      format: "json",
      name: "工程",
      saveAs: false,
    });
    expect(new TextDecoder().decode(body)).toBe("{}");
  });

  it("reads the opened file from the host's frame", async () => {
    const invoke: RawInvoke = async () =>
      frame(
        { status: "opened", fileId: 7, fileName: "第1工程.json" },
        encoder.encode('{"a":1}'),
      ).buffer as ArrayBuffer;
    const opened = await nativeProjectFiles(invoke).open();
    expect(opened?.fileId).toBe(7);
    expect(opened?.file.name).toBe("第1工程.json");
    expect(await opened?.file.text()).toBe('{"a":1}');
  });

  it("answers null for a cancelled dialog", async () => {
    const service = nativeProjectFiles(async (command) =>
      command === "project_open"
        ? frame({ status: "cancelled" }, new Uint8Array()).buffer
        : { status: "cancelled" },
    );
    expect(await service.open()).toBeNull();
    expect(
      await service.save({
        fileId: null,
        format: "package",
        name: "A",
        saveAs: true,
        content: encoder.encode("PK"),
      }),
    ).toBeNull();
  });

  it("turns the host's refusal into a readable error", async () => {
    const service = nativeProjectFiles(async () => {
      throw "unauthorized";
    });
    const error = await service
      .save({
        fileId: null,
        format: "json",
        name: "A",
        saveAs: false,
        content: encoder.encode("{}"),
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ProjectFileError);
    expect(error.reason).toBe("unauthorized");
    expect(error.message).toBe(
      "Project の保存には Admin でのログインが必要です。",
    );
  });

  it("refuses a cut frame", () => {
    expect(() => unframe(new Uint8Array([9, 0, 0, 0, 123]))).toThrow(
      ProjectFileError,
    );
  });
});
