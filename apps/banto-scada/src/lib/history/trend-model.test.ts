import { expect, it } from "vitest";
import { historyTime } from "./trend-model";

it("formats UTC epochs and falls back outside the Date range", () => {
  expect(historyTime(0)).toBe("1970-01-01T00:00:00.000Z");
  expect(historyTime(Number.MAX_SAFE_INTEGER)).toBe(
    `${Number.MAX_SAFE_INTEGER} ms`,
  );
});
