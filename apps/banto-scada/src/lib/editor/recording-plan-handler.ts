import type { Project } from "../project";
import type { ProjectCommand } from "./commands";
import {
  assertRecordingPlanTarget,
  sameRecordingPlan,
  validateRecordingPlanEdit,
} from "../recording-plan-edit";

export function applyRecordingPlanCommand(
  next: Project,
  command: Extract<
    ProjectCommand,
    { type: "save-recording-plan" | "remove-recording-plan" }
  >,
): void {
  assertRecordingPlanTarget(next.recordingPlan, command.expected);
  if (command.type === "remove-recording-plan") {
    delete next.recordingPlan;
    return;
  }
  const plan = validateRecordingPlanEdit(next.recordingPlan, command.plan);
  if (!next.recordingPlan || !sameRecordingPlan(next.recordingPlan, plan))
    next.recordingPlan = plan;
}
