import { expect, it } from "vitest";
import sample from "../../../../../examples/read-presentation.project.json";
import { frame } from "../project-file";
import {
  alarmDefinitionNotice,
  loadRuntimeProject,
  projectFailureText,
  RECONNECT_IN_EDITOR,
  runtimeHubView,
} from "./runtime-state";

it("words the three alarm-definition cases and nothing when they match", () => {
  expect(alarmDefinitionNotice("notApplied")).toBe(
    "警報の定義が適用されていません（Editor で適用してください）",
  );
  expect(alarmDefinitionNotice("otherProject")).toBe(
    "この端末の警報は、別の Project の定義で動いています",
  );
  expect(alarmDefinitionNotice("differs")).toBe(
    "警報の定義が、この Project と違います",
  );
  expect(alarmDefinitionNotice("same")).toBeNull();
  expect(alarmDefinitionNotice(undefined)).toContain("確かめられません");
});

it("asks for Editor when the saved Hub cannot be used", () => {
  expect(
    runtimeHubView({
      ok: false,
      error: {
        reason: "reconnectInEditor",
        status: { state: "notConfigured" },
      },
    }),
  ).toEqual({
    connected: false,
    needsEditor: true,
    tagCount: 0,
    text: RECONNECT_IN_EDITOR,
  });
  expect(runtimeHubView({ ok: false, error: "unreachable" })).toMatchObject({
    connected: false,
    needsEditor: false,
  });
  expect(
    runtimeHubView({ ok: true, status: { state: "connected", tagCount: 4 } }),
  ).toMatchObject({ connected: true, tagCount: 4 });
});

it("words the failure reasons", () => {
  expect(projectFailureText("unreadable")).toBe("ファイルを読めません");
  expect(projectFailureText("invalidFormat")).toBe("Project の形式が違います");
});

it("reads the startup Project like an opened file", async () => {
  const body = new TextEncoder().encode(JSON.stringify(sample));
  const opened = await loadRuntimeProject(async () =>
    frame(
      { status: "opened", fileName: "plant.json", projectDigest: "ab" },
      body,
    ),
  );
  expect(opened).toMatchObject({
    status: "opened",
    fileName: "plant.json",
    projectDigest: "ab",
  });
  if (opened.status === "opened") opened.store.dispose();

  expect(
    await loadRuntimeProject(async () =>
      frame(
        {
          status: "failed",
          fileName: "x.json",
          reason: "unreadable",
          detail: "",
        },
        new Uint8Array(),
      ),
    ),
  ).toEqual({ status: "failed", fileName: "x.json", reason: "unreadable" });

  expect(
    await loadRuntimeProject(async () =>
      frame(
        { status: "opened", fileName: "bad.json", projectDigest: "cd" },
        new TextEncoder().encode("{}"),
      ),
    ),
  ).toEqual({
    status: "failed",
    fileName: "bad.json",
    reason: "invalidFormat",
  });
});
