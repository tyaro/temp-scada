import { describe, expect, it } from "vitest";
import fixtures from "../../../../../examples/recording-management-cases.json";
import type { RecordingInspectionResponse } from "../recording-management-contract";
import { inspectedAtLabel, recordingSummary } from "./summary";

const base = (name: keyof typeof fixtures.bases) =>
  structuredClone(
    fixtures.bases[name],
  ) as unknown as RecordingInspectionResponse;
type Available = Extract<
  RecordingInspectionResponse["database"],
  { state: "available" }
>;
function withDatabase(
  name: keyof typeof fixtures.bases,
  patch: Partial<Available>,
): RecordingInspectionResponse {
  const response = base(name);
  return {
    ...response,
    database: { ...(response.database as Available), ...patch },
  };
}

describe("recordingSummary", () => {
  it("reports recording while the DB has an active session", () => {
    expect(recordingSummary(base("active"))).toMatchObject({
      state: "recording",
      label: "記録中",
      variant: "success",
    });
    expect(recordingSummary(base("observed")).state).toBe("recording");
  });

  it("asks for a look when the Host cannot be recording", () => {
    const response = base("observed");
    const summary = recordingSummary({
      ...response,
      host: { ...(response.host as object), phase: "faulted" },
    } as RecordingInspectionResponse);
    expect(summary).toMatchObject({ state: "attention", variant: "danger" });
    expect(summary.detail).toContain("異常");
  });

  it("separates stopped, interrupted, unconfigured and unknown", () => {
    expect(recordingSummary(base("terminal"))).toMatchObject({
      state: "stopped",
      label: "記録停止中",
      variant: "warning",
    });
    const active = base("active").database as Available;
    expect(
      recordingSummary(
        withDatabase("active", {
          activeSessionId: null,
          latestActivation: {
            ...active.latestActivation!,
            state: "interrupted",
          },
        }),
      ),
    ).toMatchObject({ state: "interrupted", variant: "danger" });
    expect(recordingSummary(base("response")).state).toBe("unconfigured");
    expect(recordingSummary(base("unavailable"))).toMatchObject({
      state: "unknown",
      variant: "warning",
    });
  });

  it("says why a stopped plan does not record", () => {
    const active = base("active").database as Available;
    const summary = recordingSummary(
      withDatabase("active", {
        activeSessionId: null,
        latestActivation: null,
        applied: {
          ...active.applied!,
          desired: { ...active.applied!.desired, enabled: false },
        },
      }),
    );
    expect(summary.state).toBe("stopped");
    expect(summary.detail).toContain("無効");
  });
});

describe("inspectedAtLabel", () => {
  it("formats the local time as HH:MM", () => {
    expect(inspectedAtLabel(new Date(2026, 10, 11, 9, 5).getTime())).toBe(
      "09:05",
    );
  });
});
