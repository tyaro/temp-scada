import { describe, expect, it } from "vitest";
import {
  changeDoneText,
  createOperationSettingsHost,
  keyPairing,
  normalizeSecret,
  parseIntervalSeconds,
  operationSettingsReasonText,
  settingsErrorCode,
  writeBadge,
  writeStateText,
  type OperationKeyStatus,
  type WriteState,
} from "./operation-settings";

const HUB = "http://127.0.0.1:8722";

function status(
  keyEndpoint: string | null,
  state: WriteState = "ready",
  hubEndpoint: string | null = HUB,
): OperationKeyStatus {
  return {
    keyEndpoint,
    hubEndpoint,
    write: { state, changedAtMs: null },
    minIntervalMs: 1000,
  };
}

describe("keyPairing", () => {
  it("is none without a key, paired with the read endpoint, else mismatch", () => {
    expect(keyPairing(status(null))).toBe("none");
    expect(keyPairing(status(HUB))).toBe("paired");
    expect(keyPairing(status("http://other:8722"))).toBe("mismatch");
    // A key with no saved read connection never writes (hub_mismatch).
    expect(keyPairing(status(HUB, "ready", null))).toBe("mismatch");
  });
});

describe("writeBadge", () => {
  it("shows reading before the first answer", () => {
    expect(writeBadge(undefined).label).toBe("書込み: 確認中");
  });

  it("a record that cannot be opened stops writes (§10)", () => {
    const badge = writeBadge({ error: "record_failed" });
    expect(badge).toMatchObject({ variant: "danger", label: "書込み: 停止" });
    expect(badge.title).toBe("操作の記録ができないため書込みを止めています");
    expect(writeBadge({ error: "ipc_failed" }).label).toBe("書込み: 状態不明");
  });

  it("orders no key, mismatch, then the write state", () => {
    expect(writeBadge({ status: status(null, "stopped") }).label).toBe(
      "書込み: キー未登録",
    );
    expect(
      writeBadge({ status: status("http://other:8722", "key_invalid") }).label,
    ).toBe("書込み: 接続先違い");
    expect(writeBadge({ status: status(HUB, "stopped") })).toMatchObject({
      variant: "danger",
      label: "書込み: 停止中",
    });
    expect(writeBadge({ status: status(HUB, "key_invalid") })).toMatchObject({
      variant: "danger",
      label: "書込み: キー無効",
    });
    // The Hub's write contract is per view; a registered key is not "writable".
    expect(writeBadge({ status: status(HUB) })).toMatchObject({
      variant: "success",
      label: "書込み: キー登録済み",
    });
  });
});

describe("the command wrapper", () => {
  it("calls the four commands and passes the secret only to register", async () => {
    const calls: [string, unknown][] = [];
    const host = createOperationSettingsHost(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        return status(HUB) as T;
      },
    );
    await host.status();
    await host.register("abc");
    await host.remove();
    await host.resume();
    await host.setMinInterval(2500);
    expect(calls).toEqual([
      ["operation_key_status", undefined],
      ["operation_key_register", { secret: "abc" }],
      ["operation_key_delete", undefined],
      ["operation_write_resume", undefined],
      ["operation_min_interval_set", { minIntervalMs: 2500 }],
    ]);
  });

  it("keeps the host's reason and names anything else an IPC failure", () => {
    expect(settingsErrorCode("forbidden")).toBe("forbidden");
    expect(settingsErrorCode(new Error("lost"))).toBe("ipc_failed");
  });
});

describe("texts", () => {
  it("names every reason the commands answer", () => {
    for (const code of [
      "unauthorized",
      "forbidden",
      "auth_unavailable",
      "auth_failed",
      "auth_phase_unavailable",
      "record_failed",
      "no_hub",
      "invalid_secret",
      "invalid_endpoint",
      "key_store",
      "invalid_interval",
      "ipc_failed",
    ])
      expect(operationSettingsReasonText(code)).not.toContain(code);
    expect(operationSettingsReasonText("other")).toContain("（other）");
  });

  it("a resume of a terminal that was not stopped says nothing changed", () => {
    expect(changeDoneText("resume", status(HUB))).toContain("再開しました");
    expect(changeDoneText("resume", status(HUB, "key_invalid"))).toContain(
      "停止中ではない",
    );
  });

  it("the ready state never claims that writes are possible", () => {
    // `ready` is the default of a terminal with no key, too.
    expect(writeStateText("ready")).not.toContain("書込みできます");
    expect(writeStateText("ready")).toContain("止まっていません");
  });

  it("drops the whitespace a paste adds around the secret only", () => {
    expect(normalizeSecret("  abc def\r\n")).toBe("abc def");
  });
});

describe("parseIntervalSeconds", () => {
  it("takes 0.1 to 60 seconds in steps of 0.1 (the host's range)", () => {
    expect(parseIntervalSeconds("1")).toBe(1000);
    expect(parseIntervalSeconds(" 2.5 ")).toBe(2500);
    expect(parseIntervalSeconds("0.1")).toBe(100);
    expect(parseIntervalSeconds("60")).toBe(60000);
    expect(parseIntervalSeconds("0.3")).toBe(300);
  });

  it("refuses what the host would refuse", () => {
    for (const input of [
      "",
      "0",
      "0.05",
      "0.15",
      "60.1",
      "-1",
      "1e3",
      "abc",
      "1,5",
    ])
      expect(parseIntervalSeconds(input), input).toBeNull();
  });

  it("names the interval it saved", () => {
    expect(
      changeDoneText("interval", { ...status(HUB), minIntervalMs: 2500 }),
    ).toBe("最小間隔を 2.5 秒にしました。次の書込みから使います。");
  });
});
