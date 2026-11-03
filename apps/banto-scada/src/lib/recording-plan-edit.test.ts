import { expect, it } from "vitest";
import example from "../../../../examples/recording.project.json";
import { createProject } from "./new-project";
import { parseProject, serializeProject } from "./project";
import {
  parseRecordingPlan,
  type DesiredRecordingPlan,
} from "./recording-plan";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import {
  recordingPlanDraft,
  recordingPlanFromDraft,
  recordingPlanKey,
} from "./recording-plan-edit";
const placed = () => parseProject(JSON.stringify(example));
const plan = () => parseRecordingPlan(example.recordingPlan);
const save = (
  value: DesiredRecordingPlan,
  expected: DesiredRecordingPlan | null,
) => ({ type: "save-recording-plan" as const, plan: value, expected });

it("creates and removes the whole setting in single Undo turns without sharing caller values", () => {
  const p = createProject(),
    candidate = structuredClone(example.recordingPlan);
  const added = recordEdit(
    p,
    emptyHistory(),
    save(parseRecordingPlan(candidate), null),
    "edit",
  );
  candidate.group.members[0].externalName = "changed caller";
  expect(added.project.recordingPlan).toEqual(example.recordingPlan);
  expect(p.recordingPlan).toBeUndefined();
  expect(added.history.past).toHaveLength(1);
  const undo = travelHistory(added.project, added.history, "undo", "edit");
  expect(undo.project.recordingPlan).toBeUndefined();
  const redo = travelHistory(undo.project, undo.history, "redo", "edit");
  expect(redo.project.recordingPlan).toEqual(added.project.recordingPlan);
  const removed = recordEdit(
    redo.project,
    redo.history,
    { type: "remove-recording-plan", expected: redo.project.recordingPlan! },
    "edit",
  );
  expect(removed.project.recordingPlan).toBeUndefined();
  expect(
    travelHistory(removed.project, removed.history, "undo", "edit").project
      .recordingPlan,
  ).toEqual(plan());
});
it("preserves a complete no-op including different object key order without advancing Project revision/history", () => {
  const p = placed(),
    old = p.recordingPlan!,
    { revision, ...rest } = old;
  const result = recordEdit(
    p,
    emptyHistory(),
    save({ revision, ...rest }, old),
    "edit",
  );
  expect(result.project).toBe(p);
  expect(result.history.past).toHaveLength(0);
});
it("preserves desired revision for member display order and restores it with Undo", () => {
  const p = placed(),
    old = p.recordingPlan!;
  const next = {
    ...old,
    group: { ...old.group, members: [...old.group.members].reverse() },
  };
  expect(recordingPlanKey(old, true)).toBe(recordingPlanKey(next, true));
  const r = recordEdit(p, emptyHistory(), save(next, old), "edit");
  expect(r.project.recordingPlan).toEqual(next);
  expect(r.project.recordingPlan?.revision).toBe(old.revision);
  expect(r.history.past).toHaveLength(1);
  expect(
    travelHistory(r.project, r.history, "undo", "edit").project.recordingPlan,
  ).toEqual(old);
});
const changes: ((p: any) => void)[] = [
  (p) => (p.enabled = !p.enabled),
  (p) => (p.group.groupId = "group:other"),
  (p) => (p.group.hubRef = "hub:other"),
  (p) => (p.group.periodMs = 2000),
  (p) => (p.group.members[0].memberId = "member:other"),
  (p) => (p.group.members[0].externalName = "別の名前"),
  (p) => (p.group.members[0].valueType = "bool"),
];
it.each(changes)(
  "requires a higher desired revision for every meaning-changing field %#",
  (change) => {
    const p = placed(),
      old = p.recordingPlan!,
      next: any = structuredClone(old),
      before = serializeProject(p);
    change(next);
    expect(() =>
      recordEdit(p, emptyHistory(), save(next, old), "edit"),
    ).toThrow("現在より大きい版");
    expect(serializeProject(p)).toBe(before);
    next.revision++;
    expect(applyCommand(p, save(next, old), "edit").recordingPlan).toEqual(
      next,
    );
  },
);
it("allows explicit revision-only updates and a separate plan ID, but never decreases the same plan revision", () => {
  const p = placed(),
    old = p.recordingPlan!,
    revisionOnly = { ...old, revision: 42 };
  const next = applyCommand(p, save(revisionOnly, old), "edit");
  expect(next.recordingPlan).toEqual(revisionOnly);
  expect(() => applyCommand(next, save(old, revisionOnly), "edit")).toThrow();
  const separate = { ...old, planId: "plan:separate" };
  expect(
    applyCommand(next, save(separate, revisionOnly), "edit").recordingPlan,
  ).toEqual(separate);
});
it("rejects stale create/update/remove targets before changing anything", () => {
  const p = placed(),
    old = p.recordingPlan!,
    before = serializeProject(p);
  for (const expected of [
    null,
    { ...old, revision: 2 },
    {
      ...old,
      group: { ...old.group, members: [...old.group.members].reverse() },
    },
  ]) {
    expect(() => applyCommand(p, save(old, expected), "edit")).toThrow(
      "開き直して",
    );
  }
  expect(() => applyCommand(createProject(), save(old, old), "edit")).toThrow();
  expect(() =>
    applyCommand(
      createProject(),
      { type: "remove-recording-plan", expected: old },
      "edit",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(
      p,
      { type: "remove-recording-plan", expected: { ...old, revision: 2 } },
      "edit",
    ),
  ).toThrow();
  expect(serializeProject(p)).toBe(before);
});
it("validates malformed commands and rejects preview edits without modifying the baseline", () => {
  const p = placed(),
    old = p.recordingPlan!,
    bad = {
      ...old,
      group: {
        ...old.group,
        members: [old.group.members[0], old.group.members[0]],
      },
    };
  expect(() => applyCommand(p, save(bad, old), "edit")).toThrow();
  expect(() =>
    applyCommand(
      p,
      { type: "remove-recording-plan", expected: old },
      "preview",
    ),
  ).toThrow();
  expect(p.recordingPlan).toEqual(plan());
});
it("keeps the maximum revision usable for no-op/order updates and rejects overflow", () => {
  const p = placed();
  p.recordingPlan = { ...plan(), revision: Number.MAX_SAFE_INTEGER };
  const old = p.recordingPlan;
  expect(applyCommand(p, save(old, old), "edit")).toBe(p);
  expect(() =>
    applyCommand(p, save({ ...old, enabled: !old.enabled }, old), "edit"),
  ).toThrow();
  expect(() =>
    applyCommand(p, save({ ...old, revision: old.revision + 1 }, old), "edit"),
  ).toThrow();
  expect(
    applyCommand(p, save({ ...plan(), planId: "plan:new" }, old), "edit")
      .recordingPlan?.revision,
  ).toBe(1);
});
it("restores old desired versions on Undo and permits a local branch without claiming deployment reservation", () => {
  const p = placed(),
    old = p.recordingPlan!,
    a = { ...old, revision: 2, enabled: true };
  const first = recordEdit(p, emptyHistory(), save(a, old), "edit");
  const undone = travelHistory(first.project, first.history, "undo", "edit");
  expect(undone.project.recordingPlan).toEqual(old);
  const b = { ...old, revision: 2, group: { ...old.group, periodMs: 2000 } };
  const branch = recordEdit(
    undone.project,
    undone.history,
    save(b, old),
    "edit",
  );
  expect(branch.project.recordingPlan).toEqual(b);
  expect(branch.history.future).toHaveLength(0);
});
it.each([
  "",
  "1.0",
  "1e3",
  " 1",
  "-1",
  "+1",
  "NaN",
  "Infinity",
  "9007199254740991.1",
  "9007199254740992",
  "1.00000000000000001",
])("rejects raw invalid numeric text without rounding: %s", (raw) => {
  const d = recordingPlanDraft(plan());
  expect(() => recordingPlanFromDraft({ ...d, revision: raw })).toThrow();
  expect(() => recordingPlanFromDraft({ ...d, periodMs: raw })).toThrow();
});
it("draft conversion preserves untouched CR/LF/Unicode/space values and owns members", () => {
  const p = plan(),
    d = recordingPlanDraft(p),
    text = " \r\n温度\u2028\u2029e\u0301 ";
  d.members[0].externalName = text;
  d.revision = String(Number.MAX_SAFE_INTEGER);
  const owned = recordingPlanFromDraft(d);
  d.members[0].externalName = "later";
  expect(owned.group.members[0].externalName).toBe(text);
  expect(owned.revision).toBe(Number.MAX_SAFE_INTEGER);
  expect(p.group.members[0].externalName).toBe(
    example.recordingPlan.group.members[0].externalName,
  );
});
