import { expect, it, vi } from "vitest";
import demo from "../../../../examples/demo-water.project.json";
import inputCases from "../../../../examples/operation-input-cases.json";
import type { SlotType } from "./equipment";
import { parseProject, type Project } from "./project";
import { slotPresentation, type SlotPresentation } from "./slot-presentation";
import {
  buildOperationRequest,
  confirmationContent,
  inputDecimals,
  operationRows,
  outcomeText,
  parseOperationInput,
  reasonText,
  SENDING_TEXT,
  UNRECORDED_TEXT,
  type OperationView,
} from "./operation";

const SCREEN = "0199d301-0000-7000-8000-000000000001";
const PLACEMENT = "0199d301-0000-7000-8000-000000000047";
const PUMP = "0199d301-0000-7000-8000-000000000022";

/** The demo Project with the same write slots as the host tests (O2b-2a). */
function project(): Project {
  const doc = structuredClone(demo) as unknown as Project;
  const pump = doc.equipment!.find((item) => item.id === PUMP)!;
  const kind = doc.equipmentTypes!.find((item) => item.id === pump.typeId)!;
  kind.slots.push(
    {
      name: "command",
      type: "bool",
      direction: "read",
      write: {
        label: "運転指令",
        buttons: [
          { label: "運転", value: true },
          { label: "停止", value: false },
        ],
      },
    },
    {
      name: "speedSp",
      type: "number",
      direction: "read",
      write: {
        label: "回転数 設定",
        input: { min: 0, max: 60 },
        buttons: [{ label: "停止", value: -1 }],
      },
    },
  );
  pump.bindings.push(
    { slotName: "command", externalName: "WWT.P101.Command" },
    { slotName: "speedSp", externalName: "WWT.P101.SpeedSp" },
  );
  return parseProject(JSON.stringify(doc));
}

it("lists the write slots of the equipment type in slot order", () => {
  const rows = operationRows(project(), PUMP);
  expect(rows).toEqual([
    {
      slotName: "command",
      slotType: "bool",
      label: "運転指令",
      buttons: [
        { index: 0, label: "運転", value: true },
        { index: 1, label: "停止", value: false },
      ],
      input: null,
    },
    {
      slotName: "speedSp",
      slotType: "number",
      label: "回転数 設定",
      buttons: [{ index: 0, label: "停止", value: -1 }],
      input: { min: 0, max: 60 },
    },
  ]);
  expect(operationRows(project(), "missing")).toEqual([]);
});

it("limits the input decimals by the largest format of the Symbol texts showing the slot", () => {
  const doc = project();
  const placement = doc.screens
    .find((screen) => screen.id === SCREEN)!
    .objects.find((object) => object.id === PLACEMENT)!;
  if (placement.shape.type !== "symbol") throw new Error("symbol placement");
  const symbolId = placement.shape.symbolId;
  expect(inputDecimals(doc, SCREEN, PLACEMENT, "speedSp")).toBeNull();
  // The same walk as the host's `slot_decimals`: any nested object that binds
  // the slot counts, a non-integral or missing `decimals` does not.
  const symbol = doc.symbols.find((item) => item.id === symbolId)!;
  (symbol as unknown as { objects: unknown[] }).objects.push(
    {
      shape: {
        type: "text",
        slotBinding: { slotName: "speedSp" },
        format: { decimals: 1 },
      },
    },
    {
      shape: {
        type: "table",
        cells: [
          [
            { slotBinding: { slotName: "speedSp" }, format: { decimals: 2 } },
            { slotBinding: { slotName: "other" }, format: { decimals: 5 } },
            { slotBinding: { slotName: "speedSp" }, format: { decimals: 1.5 } },
          ],
        ],
      },
    },
    { shape: { slotBinding: { slotName: "speedSp" }, format: { unit: "Hz" } } },
  );
  expect(inputDecimals(doc, SCREEN, PLACEMENT, "speedSp")).toBe(2);
  expect(inputDecimals(doc, SCREEN, PLACEMENT, "other")).toBe(5);
  expect(inputDecimals(doc, SCREEN, PLACEMENT, "none")).toBeNull();
  expect(inputDecimals(doc, SCREEN, "missing", "speedSp")).toBeNull();
  expect(inputDecimals(doc, "missing", PLACEMENT, "speedSp")).toBeNull();
});

type InputCase = {
  name: string;
  text: string;
  slotType: SlotType;
  decimals: number | null;
  input: { min: number; max: number } | null;
  expect: { value: number; fractional: boolean } | { reason: string };
};
it.each(inputCases as InputCase[])(
  "operation input shared contract: $name",
  ({ text, slotType, decimals, input, expect: expected }) => {
    expect(parseOperationInput(text, slotType, decimals, input)).toEqual(
      "reason" in expected
        ? { ok: false, reason: expected.reason }
        : { ok: true, ...expected },
    );
  },
);

it("builds the host request with exactly one of a button and an input", () => {
  const target = {
    projectId: "p",
    projectDigest: "d",
    screenId: SCREEN,
    objectId: PLACEMENT,
    equipmentId: PUMP,
    slotName: "speedSp",
  };
  expect(
    buildOperationRequest({
      ...target,
      choice: { input: "12.5" },
      expectedValue: 12.5,
    }),
  ).toEqual({ ...target, input: "12.5", expectedValue: 12.5 });
  const button = buildOperationRequest({
    ...target,
    slotName: "command",
    choice: { buttonIndex: 1 },
    expectedValue: false,
  });
  expect(button).toEqual({
    ...target,
    slotName: "command",
    buttonIndex: 1,
    expectedValue: false,
  });
  expect("input" in button).toBe(false);
});

it("shows the equipment, the row, the current value with its quality and the value to write", () => {
  const [command, speed] = operationRows(project(), PUMP);
  const equipment = { name: "1号ポンプ", code: "P-101" };
  const good: SlotPresentation = {
    state: "good",
    label: "Good",
    text: "true",
    value: { type: "bool", value: true },
    provenance: {} as never,
  };
  expect(
    confirmationContent(equipment, command, good, { buttonIndex: 1 }),
  ).toEqual({
    equipmentName: "1号ポンプ",
    equipmentCode: "P-101",
    label: "運転指令",
    currentText: "true",
    quality: "Good",
    writeText: "停止（false）",
  });
  expect(
    confirmationContent(equipment, speed, slotPresentation("bad"), {
      input: "12.50",
    }),
  ).toMatchObject({ currentText: "--", quality: "不良", writeText: "12.50" });
});

it("has the §5 outcome texts and fails closed on an unknown outcome", () => {
  expect(outcomeText("ok")).toBe("書込みました");
  expect(outcomeText("refused")).toBe("送っていません");
  expect(outcomeText("not_sent")).toBe("書込み先へは送られていません");
  expect(outcomeText("stopped")).toBe("この端末の書込みは停止中");
  expect(outcomeText("failed")).toBe("書込みは成立していません");
  expect(outcomeText("uncertain")).toBe(
    "書けたか分かりません。現在値を確かめてください",
  );
  expect(outcomeText("future")).toBe(outcomeText("uncertain"));
  expect(SENDING_TEXT).toBe("送信中");
  expect(UNRECORDED_TEXT).toBe(
    "結果を記録できませんでした。現在値を確かめてください",
  );
});

it("has a text for every host reason code and names an unknown code", async () => {
  // Node-only fixture IO; keep the application's browser-only type environment.
  const { readFileSync } = await vi.importActual<{
    readFileSync(path: URL, encoding: "utf8"): string;
  }>("node:fs");
  const read = (path: string) =>
    readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
  const reasons = /pub mod reason \{([^}]*)\}/.exec(
    read("crates/scada-host/src/operation_write.rs"),
  )![1];
  const codes = [...reasons.matchAll(/: &str = "([a-z_]+)";/g)].map(
    (match) => match[1],
  );
  const interrupted = /pub const INTERRUPTED: &str = "([a-z_]+)";/.exec(
    read("crates/scada-host/src/operation_db.rs"),
  )![1];
  expect(codes.length).toBeGreaterThan(20);
  for (const code of [...codes, interrupted])
    expect(reasonText(code), code).not.toMatch(/^不明な理由/);
  // tagclient `ErrorKind::as_str()` at the pinned banto-industrial commit.
  for (const code of [
    "invalid_secret",
    "invalid_endpoint",
    "invalid_tag_selection",
    "duplicate_binding_key",
    "duplicate_requested_external_name",
    "duplicate_catalog_external_name",
    "binding_unresolved",
    "unauthorized",
    "transport",
    "protocol_error",
    "catalog_unavailable",
    "revision_mismatch",
    "runtime_metadata_mismatch",
    "stopped",
    "write_forbidden",
    "write_unavailable",
    "write_rejected",
    "write_uncertain",
    "invalid_write_options",
    "key_revoked",
    "key_expired",
    "key_tripped",
    "key_not_found",
    "credential_rejected",
  ])
    expect(reasonText(code), code).not.toMatch(/^不明な理由/);
  expect(reasonText("from_the_future")).toBe("不明な理由（from_the_future）");
  expect(reasonText("toString")).toBe("不明な理由（toString）");
});

it("types the host's operation_view answer as it is on the wire", () => {
  // The JSON of the host test the_view_lists_the_write_slots_with_their_last_requests
  // (auditId is Rust Option<i64>) and of the answer without an applied Project.
  const found = {
    projectId: "p",
    projectDigest: "d",
    blocked: null,
    phase: "initializing",
    slots: [
      {
        slot: "command",
        latest: {
          id: "0199d301-0000-7000-8000-0000000000aa",
          state: "finished",
          outcome: "ok",
          reason: null,
          requestedAtMs: 1,
          finishedAtMs: 2,
          tag: "PUMP.CMD",
          value: false,
          auditId: 42,
        },
      },
      { slot: "speedSp", latest: null },
    ],
  } satisfies OperationView;
  const noProject = {
    projectId: null,
    projectDigest: null,
    blocked: "project_changed",
    phase: "initializing",
    slots: [],
  } satisfies OperationView;
  expect(typeof found.slots[0].latest?.auditId).toBe("number");
  expect(noProject.projectId).toBeNull();
});
