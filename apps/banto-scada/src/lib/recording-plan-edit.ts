import {
  parseRecordingPlan,
  type DesiredRecordingPlan,
} from "./recording-plan";

import { recordingPlanKey } from "./recording-plan-comparison";
export { recordingPlanKey } from "./recording-plan-comparison";

export function sameRecordingPlan(
  a: DesiredRecordingPlan,
  b: DesiredRecordingPlan,
): boolean {
  return (
    a.revision === b.revision && recordingPlanKey(a) === recordingPlanKey(b)
  );
}
/** Local editing rules do not reserve a revision at a deployment. */
export function validateRecordingPlanEdit(
  current: DesiredRecordingPlan | undefined,
  input: unknown,
): DesiredRecordingPlan {
  const next = parseRecordingPlan(input);
  if (current?.planId === next.planId) {
    if (
      next.revision < current.revision ||
      (recordingPlanKey(current, true) !== recordingPlanKey(next, true) &&
        next.revision <= current.revision)
    )
      throw Error(
        "同じ計画IDで内容を変える場合は、現在より大きい版を指定してください。",
      );
  }
  return next;
}
export function assertRecordingPlanTarget(
  current: DesiredRecordingPlan | undefined,
  expected: DesiredRecordingPlan | null,
): void {
  if (
    expected === null
      ? current !== undefined
      : !current || !sameRecordingPlan(current, parseRecordingPlan(expected))
  )
    throw Error("記録希望設定が変更されています。開き直してください。");
}

export interface RecordingPlanDraft {
  planId: string;
  revision: string;
  enabled: boolean;
  groupId: string;
  hubRef: string;
  periodMs: string;
  members: {
    memberId: string;
    externalName: string;
    valueType: "number" | "bool";
  }[];
}
export function recordingPlanDraft(
  plan: DesiredRecordingPlan,
): RecordingPlanDraft {
  return {
    planId: plan.planId,
    revision: String(plan.revision),
    enabled: plan.enabled,
    groupId: plan.group.groupId,
    hubRef: plan.group.hubRef,
    periodMs: String(plan.group.periodMs),
    members: plan.group.members.map((m) => ({ ...m })),
  };
}
function integer(raw: string): number {
  if (!/^[0-9]{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw Error("版と周期には範囲内の整数を入力してください。");
  return Number(raw);
}
export function recordingPlanFromDraft(
  draft: RecordingPlanDraft,
): DesiredRecordingPlan {
  return parseRecordingPlan({
    version: 1,
    kind: "recordingPlan",
    planId: draft.planId,
    revision: integer(draft.revision),
    enabled: draft.enabled,
    group: {
      groupId: draft.groupId,
      hubRef: draft.hubRef,
      periodMs: integer(draft.periodMs),
      members: draft.members.map((m) => ({ ...m })),
    },
  });
}
