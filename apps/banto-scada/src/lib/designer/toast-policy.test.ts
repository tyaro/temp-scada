import { describe, expect, it } from "vitest";
import { shouldShowToast } from "./toast-policy";

describe("shouldShowToast", () => {
  it("通常の成功はステータス行だけにする", () => {
    expect(shouldShowToast("success")).toBe(false);
  });
  it("失敗・警告・案内はトーストに出す", () => {
    expect(shouldShowToast("error")).toBe(true);
    expect(shouldShowToast("warning")).toBe(true);
    expect(shouldShowToast("info")).toBe(true);
  });
  it("明示の指定が種類の既定より優先される", () => {
    expect(shouldShowToast("success", { toast: true })).toBe(true);
    expect(shouldShowToast("info", { toast: false })).toBe(false);
  });
});
