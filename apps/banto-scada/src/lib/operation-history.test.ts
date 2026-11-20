import { describe, expect, it, vi } from "vitest";
import demo from "../../../../examples/demo-water.project.json";
import { parseProject, type Project } from "./project";
import {
  createOperationHistoryHost,
  durationText,
  HISTORY_OUTCOMES,
  operationHistoryLine,
  operationHistoryQuery,
  type HistoryOutcome,
  type OperationHistoryRow,
} from "./operation-history";
import {
  outcomeText,
  reasonText,
  SENDING_TEXT,
  UNRECORDED_TEXT,
} from "./operation";

const PUMP = "0199d301-0000-7000-8000-000000000022";
const ALL = HISTORY_OUTCOMES.map(([outcome]) => outcome);

function project(): Project {
  const doc = structuredClone(demo) as unknown as Project;
  const pump = doc.equipment!.find((item) => item.id === PUMP)!;
  const kind = doc.equipmentTypes!.find((item) => item.id === pump.typeId)!;
  kind.slots.push({
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
  });
  pump.bindings.push({ slotName: "command", externalName: "WWT.P101.Command" });
  return parseProject(JSON.stringify(doc));
}

function row(patch: Partial<OperationHistoryRow> = {}): OperationHistoryRow {
  return {
    seq: 7,
    id: "r7",
    state: "finished",
    outcome: "ok",
    reason: null,
    requestedAtMs: 1_000,
    finishedAtMs: 1_250,
    tag: "WWT.P101.Command",
    value: true,
    auditId: 42,
    user: "未ログイン",
    equipmentId: PUMP,
    equipmentCode: "P-101",
    slot: "command",
    input: null,
    repeatCount: 1,
    ...patch,
  };
}

describe("operationHistoryQuery", () => {
  const filter = { from: "", to: "", equipmentId: "", outcomes: ALL };

  it("omits every condition that is not set", () => {
    expect(operationHistoryQuery(filter)).toEqual({ query: {} });
  });

  it("sends the period, the equipment, a subset of outcomes and the cursor", () => {
    const from = "2026-11-20T08:00:00",
      to = "2026-11-20T09:00:00";
    const outcomes: HistoryOutcome[] = ["pending", "ok"];
    expect(
      operationHistoryQuery({ from, to, equipmentId: PUMP, outcomes }, 12),
    ).toEqual({
      query: {
        fromMs: new Date(from).getTime(),
        toMs: new Date(to).getTime(),
        equipmentId: PUMP,
        // In the table's order, not the selection's.
        outcomes: ["ok", "pending"],
        beforeSeq: 12,
      },
    });
  });

  it("refuses a reversed or broken period and an empty outcome set", () => {
    expect(
      operationHistoryQuery({
        ...filter,
        from: "2026-11-20T09:00",
        to: "2026-11-20T08:00",
      }),
    ).toEqual({ issue: "開始は終了より前にしてください。" });
    expect(operationHistoryQuery({ ...filter, from: "nope" })).toEqual({
      issue: "期間の日時を正しく入れてください。",
    });
    expect(operationHistoryQuery({ ...filter, outcomes: [] })).toEqual({
      issue: "区分を 1 つ以上選んでください。",
    });
  });
});

describe("operationHistoryLine", () => {
  it("names the equipment and the operation from the Project", () => {
    const line = operationHistoryLine(row(), project());
    expect(line).toMatchObject({
      seq: 7,
      user: "未ログイン",
      equipment: expect.stringMatching(/^P-101 .+/),
      operation: "運転指令",
      // 記録どおりの値。今のボタン名（運転）は付けない。
      value: "true",
      outcome: outcomeText("ok"),
      reason: "",
      repeat: "",
      duration: "250 ms",
      auditId: "42",
    });
  });

  it("shows the reason, the folded count and the stored names without a Project", () => {
    const line = operationHistoryLine(
      row({
        outcome: "refused",
        reason: "phase_unavailable",
        auditId: null,
        repeatCount: 3,
        equipmentId: "gone",
        equipmentCode: null,
        slot: "speedSp",
        value: null,
        input: "12.5",
      }),
      undefined,
    );
    expect(line).toMatchObject({
      equipment: "gone",
      operation: "speedSp",
      value: "12.5",
      outcome: outcomeText("refused"),
      reason: reasonText("phase_unavailable"),
      repeat: "×3",
      auditId: "",
    });
  });

  it("uses the host's state for a row whose outcome is not recorded", () => {
    const sending = operationHistoryLine(
      row({
        state: "sending",
        outcome: null,
        finishedAtMs: null,
        auditId: null,
      }),
      project(),
    );
    expect(sending.outcome).toBe(SENDING_TEXT);
    expect(sending.duration).toBe("");
    const unrecorded = operationHistoryLine(
      row({ state: "unrecorded", outcome: null, finishedAtMs: null }),
      project(),
    );
    expect(unrecorded.outcome).toBe(UNRECORDED_TEXT);
    const known = operationHistoryLine(
      row({ state: "unrecorded", outcome: "failed" }),
      project(),
    );
    expect(known.outcome).toBe(`${UNRECORDED_TEXT}・${outcomeText("failed")}`);
  });

  it("writes seconds from one second on", () => {
    expect(durationText(row({ finishedAtMs: 3_400 }))).toBe("2.4 秒");
  });
});

it("asks the host with the query as the request", async () => {
  const invoke = vi.fn().mockResolvedValue({
    projectId: "p",
    rows: [],
    nextBeforeSeq: null,
  });
  await createOperationHistoryHost(invoke).history({ beforeSeq: 3 });
  expect(invoke).toHaveBeenCalledWith("operation_history", {
    request: { beforeSeq: 3 },
  });
});
