// Shared fixture recipes only; never imported by App or the validator.
import cases from "../../../../../examples/recording-plan-cases.json";
export { cases };
export interface RecordingPlanCase {
  name: string;
  accepted: boolean;
  input?: unknown;
  json?: string;
  build?: string;
  count?: number;
}
export function recordingPlanCaseInput(fixture: RecordingPlanCase): unknown {
  if (fixture.json !== undefined) return JSON.parse(fixture.json);
  if (!fixture.build) return structuredClone(fixture.input);
  const count = fixture.count!;
  if (fixture.build === "bytes") return "x".repeat(count - 2);
  if (fixture.build === "nodes")
    return Array.from({ length: count }, () => null);
  if (fixture.build === "depth") {
    let result: unknown = null;
    for (let i = 0; i < count; i++) result = [result];
    return result;
  }
  throw Error("Unknown recording plan fixture recipe");
}
