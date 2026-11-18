import { describe, expect, it } from "vitest";
import type { UiSettingsProvider } from "@banto/admin-core";
import { createUiPreference } from "./ui-preference";

/** `set` を手で解決する provider。送信の順序と同時数を記録する。 */
function heldProvider(stored: Record<string, string> = {}) {
  const sent: string[] = [];
  const pending: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let getFails = false;
  const provider: UiSettingsProvider = {
    async get(key) {
      if (getFails) throw new Error("blocked");
      return stored[key] ?? null;
    },
    set(key, value) {
      sent.push(value);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      return new Promise<void>((resolve, reject) => {
        pending.push({
          resolve: () => {
            inflight--;
            stored[key] = value;
            resolve();
          },
          reject: (e) => {
            inflight--;
            reject(e);
          },
        });
      });
    },
  };
  return {
    provider,
    sent,
    pending,
    stored,
    maxInflight: () => maxInflight,
    failGet: () => (getFails = true),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function widthPreference(
  provider: UiSettingsProvider,
  warnings: string[] = [],
) {
  return createUiPreference<number>({
    provider,
    key: "scada.test.width",
    parse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : undefined),
    serialize: String,
    fallback: () => 240,
    warn: (message) => warnings.push(message),
    saveFailed: "保存できません",
    loadFailed: "読み込めません",
  });
}

describe("createUiPreference", () => {
  it("送信中の変更は1回にまとめ、最後の値を順番に書く", async () => {
    const store = heldProvider();
    const width = widthPreference(store.provider);
    const first = width.update(250);
    const second = width.update(260);
    const third = width.update(270);
    expect(store.sent).toEqual(["250"]);
    expect(width.current).toBe(270);
    store.pending[0].resolve();
    await flush();
    expect(store.sent).toEqual(["250", "270"]);
    store.pending[1].resolve();
    expect(await Promise.all([first, second, third])).toEqual([
      true,
      true,
      true,
    ]);
    expect(store.maxInflight()).toBe(1);
    expect(store.stored["scada.test.width"]).toBe("270");
    expect(width.saved).toBe(270);
  });

  it("失敗は今の値を残し、保存済みは前の値のまま。まとめた保存の失敗は1回だけ通知する", async () => {
    const store = heldProvider();
    const warnings: string[] = [];
    const width = widthPreference(store.provider, warnings);
    const ok = width.update(250);
    store.pending[0].resolve();
    expect(await ok).toBe(true);

    const a = width.update(300);
    const b = width.update(310);
    const c = width.update(320);
    store.pending[1].reject(new Error("full"));
    await flush();
    store.pending[2].reject(new Error("full"));
    expect(await Promise.all([a, b, c])).toEqual([false, false, false]);
    // 送信2回の失敗で通知2回（まとめた b・c は同じ失敗を共有して1回）。
    expect(warnings).toEqual(["保存できません", "保存できません"]);
    expect(width.current).toBe(320);
    expect(width.saved).toBe(250);
  });

  it("壊れた値は既定値で通知なし、読込みの失敗だけを通知する", async () => {
    const broken = heldProvider({ "scada.test.width": "-50" });
    const warnings: string[] = [];
    const width = widthPreference(broken.provider, warnings);
    await width.load();
    expect(width.current).toBe(240);
    expect(width.saved).toBeUndefined();
    expect(warnings).toEqual([]);

    const blocked = heldProvider({ "scada.test.width": "300" });
    blocked.failGet();
    const other = widthPreference(blocked.provider, warnings);
    await other.load();
    expect(other.current).toBe(240);
    expect(warnings).toEqual(["読み込めません"]);
  });

  it("既定に戻すだけでは書かず、save の失敗は通知しない", async () => {
    const store = heldProvider({ "scada.test.width": "300" });
    const warnings: string[] = [];
    const width = widthPreference(store.provider, warnings);
    await width.load();
    expect(width.current).toBe(300);
    width.resetToDefault();
    expect(width.current).toBe(240);
    expect(store.sent).toEqual([]);
    const saving = width.save();
    store.pending[0].reject(new Error("full"));
    expect(await saving).toBe(false);
    expect(warnings).toEqual([]);
    expect(width.saved).toBe(300);
  });
});
