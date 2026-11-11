import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatOffset,
  localInputToUtc,
  recentRange,
  utcToLocalInput,
} from "./time-input";

const JST = 540;
describe("time-input", () => {
  it("converts UTC to local and back for several offsets", () => {
    const utc = "2026-11-02T00:30:15.000Z";
    expect(utcToLocalInput(utc, JST)).toBe("2026-11-02T09:30:15");
    expect(utcToLocalInput(utc, -300)).toBe("2026-11-01T19:30:15");
    expect(utcToLocalInput(utc, 0)).toBe("2026-11-02T00:30:15");
    expect(localInputToUtc("2026-11-02T09:30:15", JST)).toBe(utc);
    expect(localInputToUtc("2026-11-01T19:30", -300)).toBe(
      "2026-11-02T00:30:00.000Z",
    );
  });
  it("rejects invalid input", () => {
    expect(localInputToUtc("", JST)).toBeUndefined();
    expect(localInputToUtc("2026-02-30T10:00", JST)).toBeUndefined();
    expect(localInputToUtc("2026-11-02 10:00", JST)).toBeUndefined();
    expect(utcToLocalInput("not-a-date", JST)).toBe("");
  });
  it("builds recent ranges ending at whole seconds", () => {
    const now = Date.parse("2026-11-02T01:00:00.789Z");
    expect(recentRange(now, 600_000)).toEqual({
      from: "2026-11-02T00:50:00.000Z",
      to: "2026-11-02T01:00:00.000Z",
    });
    expect(recentRange(now, 3_600_000).from).toBe("2026-11-02T00:00:00.000Z");
  });
  it("formats durations with units", () => {
    expect(formatDuration(3_600_000)).toBe("1時間");
    expect(formatDuration(600_000)).toBe("10分");
    expect(formatDuration(5_400_000)).toBe("1時間30分");
    expect(formatDuration(90_000)).toBe("1分30秒");
    expect(formatDuration(1500)).toBe("1.5秒");
    expect(formatDuration(250)).toBe("250ミリ秒");
    expect(formatDuration(-1)).toBe("不明");
  });
  it("formats offsets", () => {
    expect(formatOffset(540)).toBe("UTC+09:00");
    expect(formatOffset(-210)).toBe("UTC-03:30");
    expect(formatOffset(0)).toBe("UTC+00:00");
  });
});
