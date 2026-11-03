/** Desired settings shared by standalone inputs and Project validation; no resolution or apply. */
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/recording-plan.schema.json";
import historySchema from "../../../../crates/scada-historian/schema/history-contract.schema.json";
import { ownHistoryJson, freezeHistory } from "./history/owned-json";
import { blankJsonText, scalarJson } from "./json-text";

export interface RecordingPlanMember {
  readonly memberId: string;
  readonly externalName: string;
  readonly valueType: "number" | "bool";
}
export interface DesiredRecordingPlan {
  readonly version: 1;
  readonly kind: "recordingPlan";
  readonly planId: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly group: {
    readonly groupId: string;
    readonly hubRef: string;
    readonly periodMs: number;
    readonly members: readonly RecordingPlanMember[];
  };
}
export const MAX_RECORDING_PLAN_JSON_BYTES = 64 * 1024;
export const MAX_RECORDING_PLAN_JSON_NODES = 4096;
// Register the canonical H1 ID resource locally; never resolve remote schemas.
const validateSchema = new Ajv2020({ strictNumbers: true })
  .addSchema(historySchema)
  .compile<DesiredRecordingPlan>(schema);
function check(input: unknown): DesiredRecordingPlan {
  const value = ownHistoryJson(
    input,
    MAX_RECORDING_PLAN_JSON_BYTES,
    MAX_RECORDING_PLAN_JSON_NODES,
  );
  if (!scalarJson(value) || !validateSchema(value)) throw Error("invalid");
  const ids = new Set<string>(),
    names = new Set<string>();
  for (const member of value.group.members) {
    if (
      ids.has(member.memberId) ||
      names.has(member.externalName) ||
      blankJsonText(member.externalName)
    )
      throw Error("invalid");
    ids.add(member.memberId);
    names.add(member.externalName);
  }
  return freezeHistory(value);
}
/** An owned, frozen snapshot, preserving strings and member order.
 * Acceptance does not prove identity, authorization or immutable deployed state. */
export function parseRecordingPlan(input: unknown): DesiredRecordingPlan {
  try {
    return check(input);
  } catch {
    throw Error("Recording plan: invalid");
  }
}
export function validateRecordingPlan(input: unknown): boolean {
  try {
    check(input);
    return true;
  } catch {
    return false;
  }
}
