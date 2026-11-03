import type { DesiredRecordingPlan } from "./recording-plan";

/** Fixed field order; member display order is ignored only for meaning comparisons. */
export function recordingPlanKey(
  plan: DesiredRecordingPlan,
  sortMembers = false,
): string {
  const members = [...plan.group.members];
  if (sortMembers)
    members.sort((a, b) =>
      a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0,
    );
  return JSON.stringify([
    plan.version,
    plan.kind,
    plan.planId,
    plan.enabled,
    plan.group.groupId,
    plan.group.hubRef,
    plan.group.periodMs,
    members.map((m) => [m.memberId, m.externalName, m.valueType]),
  ]);
}
