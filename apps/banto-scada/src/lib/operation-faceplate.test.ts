import { describe, expect, it, vi } from "vitest";
import {
  createOperationHost,
  faceplateNotice,
  INITIALIZING_TEXT,
  ipcErrorText,
  writeErrorText,
  requestedValueText,
  WRITE_UNKNOWN_TEXT,
  LOADING_TEXT,
  NO_PLACEMENT_TEXT,
  rowStatus,
  type ViewState,
} from "./operation-faceplate";
import {
  SENDING_TEXT,
  UNRECORDED_TEXT,
  type OperationLatest,
  type OperationView,
  type WriteResult,
} from "./operation";

const runtime = { projectId: "p", projectDigest: "d" };
const placement = { screenId: "s", objectId: "o" };
const view = (patch: Partial<OperationView> = {}): ViewState => ({
  status: "ready",
  view: {
    projectId: "p",
    projectDigest: "d",
    blocked: null,
    phase: "operational",
    slots: [],
    ...patch,
  },
});
const latest = (patch: Partial<OperationLatest> = {}): OperationLatest => ({
  id: "r1",
  state: "finished",
  outcome: "ok",
  reason: null,
  requestedAtMs: 1,
  finishedAtMs: 2,
  tag: "T",
  value: true,
  auditId: 42,
  ...patch,
});
const result = (patch: Partial<WriteResult> = {}): WriteResult => ({
  outcome: "ok",
  reason: null,
  tag: "T",
  value: true,
  auditId: 42,
  recordId: "r1",
  unrecorded: false,
  ...patch,
});

describe("faceplateNotice", () => {
  it("disables while loading, on an IPC error and when blocked, without the banner", () => {
    expect(
      faceplateNotice({ status: "loading" }, placement, false, runtime),
    ).toEqual({ disabled: LOADING_TEXT, banner: null });
    expect(
      faceplateNotice(
        { status: "error", message: "x" },
        placement,
        false,
        runtime,
      ).disabled,
    ).toContain("x");
    expect(
      faceplateNotice(
        view({ blocked: "hub_unsupported", phase: "initializing" }),
        placement,
        false,
        runtime,
      ),
    ).toEqual({ disabled: "Hub が書込みに対応していません", banner: null });
  });
  it("disables a view without the Runtime's Project", () => {
    for (const patch of [
      { projectId: null, projectDigest: null },
      { projectId: "other" },
      { projectDigest: "other" },
    ])
      expect(
        faceplateNotice(view(patch), placement, false, runtime).disabled,
      ).toBe("画面の定義が変わりました。小窓を開き直してください");
  });
  it("shows the initializing banner only when not blocked", () => {
    expect(
      faceplateNotice(
        view({ phase: "initializing" }),
        placement,
        false,
        runtime,
      ),
    ).toEqual({ disabled: null, banner: INITIALIZING_TEXT });
    expect(faceplateNotice(view(), placement, false, runtime)).toEqual({
      disabled: null,
      banner: null,
    });
  });
  it("needs the pressed placement and stops while sending", () => {
    expect(faceplateNotice(view(), null, false, runtime).disabled).toBe(
      NO_PLACEMENT_TEXT,
    );
    expect(faceplateNotice(view(), placement, true, runtime).disabled).toBe(
      SENDING_TEXT,
    );
  });
});

describe("rowStatus", () => {
  it("shows the record's last row", () => {
    expect(rowStatus(null, null)).toBeNull();
    expect(rowStatus(latest(), null)).toEqual({
      texts: ["書込みました"],
      reason: null,
      atMs: 2,
      value: "true",
      notice: null,
    });
    expect(
      rowStatus(
        latest({ outcome: "refused", reason: "too_soon", finishedAtMs: 3 }),
        null,
      ),
    ).toEqual({
      texts: ["送っていません"],
      reason: "前の書込みから間がありません",
      atMs: 3,
      value: "true",
      notice: null,
    });
    expect(
      rowStatus(
        latest({ state: "sending", outcome: null, finishedAtMs: null }),
        null,
      ),
    ).toEqual({
      texts: [SENDING_TEXT],
      reason: null,
      atMs: null,
      value: "true",
      notice: null,
    });
    expect(
      rowStatus(latest({ state: "unrecorded", outcome: null }), null)?.texts,
    ).toEqual([UNRECORDED_TEXT]);
    expect(
      rowStatus(latest({ state: "unrecorded", outcome: "failed" }), null)
        ?.texts,
    ).toEqual([UNRECORDED_TEXT, "書込みは成立していません"]);
  });
  it("prefers the record once it holds this answer", () => {
    expect(
      rowStatus(latest(), {
        kind: "result",
        result: result(),
        atMs: 9,
      })?.atMs,
    ).toBe(2);
  });
  it("shows an answer the record does not hold", () => {
    expect(
      rowStatus(latest(), {
        kind: "result",
        result: result({
          outcome: "refused",
          reason: "invalid_request",
          recordId: null,
        }),
        atMs: 9,
      }),
    ).toEqual({
      texts: ["送っていません"],
      reason: "要求の形が正しくありません",
      atMs: 9,
      value: "true",
      notice: null,
    });
    expect(
      rowStatus(latest(), {
        kind: "result",
        result: result({ outcome: "uncertain", unrecorded: true }),
        atMs: 9,
      })?.texts,
    ).toEqual(["書けたか分かりません。現在値を確かめてください", "記録に失敗"]);
    // The write's answer was lost: a notice kept apart from the record's
    // last row, which may be another operation's, and never cleared by it.
    const lost = {
      kind: "error" as const,
      message: WRITE_UNKNOWN_TEXT,
      value: 12.5,
    };
    expect(rowStatus(null, lost)).toEqual({
      texts: [],
      reason: null,
      atMs: null,
      value: null,
      notice: { text: WRITE_UNKNOWN_TEXT, value: "12.5" },
    });
    const other = rowStatus(latest(), lost);
    expect(other?.texts).toEqual(["書込みました"]);
    expect(other?.notice).toEqual({ text: WRITE_UNKNOWN_TEXT, value: "12.5" });
    // A newer row with another id does not clear the notice either.
    expect(rowStatus(latest({ id: "newer" }), lost)?.notice?.text).toBe(
      WRITE_UNKNOWN_TEXT,
    );
  });
});

describe("requestedValueText", () => {
  it("names the button of the value, else the value itself", () => {
    const row = {
      buttons: [
        { index: 0, label: "運転", value: true },
        { index: 1, label: "停止", value: false },
      ],
    };
    expect(requestedValueText(false, row)).toBe("停止（false）");
    expect(requestedValueText(12.5, row)).toBe("12.5");
    expect(requestedValueText(true, null)).toBe("true");
    expect(requestedValueText(null, row)).toBeNull();
    expect(requestedValueText(undefined, row)).toBeNull();
    // The record's last row shows its value with the button's label.
    expect(rowStatus(latest({ value: false }), null, row)?.value).toBe(
      "停止（false）",
    );
  });
});

describe("host", () => {
  it("sends both commands as { request }", async () => {
    const invoke = vi.fn(async () => ({}));
    const host = createOperationHost(invoke, "p", "d");
    await host.view("e");
    expect(invoke).toHaveBeenLastCalledWith("operation_view", {
      request: { equipmentId: "e" },
    });
    const request = {
      projectId: "p",
      projectDigest: "d",
      screenId: "s",
      objectId: "o",
      equipmentId: "e",
      slotName: "run",
      expectedValue: true,
      buttonIndex: 0,
    };
    await host.write(request);
    expect(invoke).toHaveBeenLastCalledWith("operation_write", { request });
  });
  it("words an IPC error", () => {
    expect(ipcErrorText("runtimeOnly")).toBe(
      "host が受け付けませんでした（不明な理由（runtimeOnly））",
    );
    expect(ipcErrorText(undefined)).toBe("host に届きません");
  });
  it("calls a lost write answer unknown, never not sent", () => {
    expect(writeErrorText("runtimeOnly")).toBe(
      "送っていません（Runtime の窓でだけ書込みできます）",
    );
    for (const error of [undefined, new Error("ipc"), "something"])
      expect(writeErrorText(error)).toBe(WRITE_UNKNOWN_TEXT);
  });
});
