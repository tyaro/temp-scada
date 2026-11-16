import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/process.project.json" with { type: "json" };
import { mainCanvas, selectPanel } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

// 最新の警報の帯。仕様: docs/design/graphics/alarm-banner.md
// 時刻はローカル時刻で出すので、タイムゾーンを固定する。
test.use({ timezoneId: "Asia/Tokyo" });

const PROJECT = sample.manifest.projectId;
const TEMP = sample.alarms.definitions[0].id;
const PUMP = sample.alarms.definitions[1].id;
const HH = `${TEMP}:hh`;
const H = `${TEMP}:h`;

const palette = (page: Page) =>
  page.getByRole("region", { name: "部品パレット", exact: true });
const banner = (page: Page) =>
  mainCanvas(page).getByRole("img", { name: /^最新の警報: / });

/** alarm-badge.spec.ts と同じく、テスト用のエントリーだけにモックの警報 feed を渡す。 */
async function mockAlarmEntry(page: Page) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const mount =
      /mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);/;
    expect(original).toMatch(mount);
    const injected = `
      const { createMockAlarmFeed } = await import("/src/lib/mock-alarm-feed.ts");
      const { feed, control } = createMockAlarmFeed();
      window.__bantoAlarmMock = control;
      mount(App, {target: document.getElementById("app"), props: {alarmFeed: feed}});`;
    await route.fulfill({ response, body: original.replace(mount, injected) });
  });
}

async function openSample(page: Page, project: unknown = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await openProject(page, {
    name: "process.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
}
async function addBanner(page: Page) {
  await selectPanel(page, "部品");
  await palette(page)
    .getByRole("searchbox", { name: "部品を検索" })
    .fill("警報");
  await palette(page)
    .getByRole("button", { name: "最新の警報の帯を追加", exact: true })
    .click();
  await expect(banner(page)).toHaveCount(1);
}

test("a banner is stopped without the Engine, even without alarm definitions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await addBanner(page);
  await expect(banner(page)).toHaveAccessibleName(
    "最新の警報: 警報 停止中（警報の状態を受け取っていません）",
  );
  await expect(banner(page)).toHaveAttribute(
    "data-alarm-banner-kind",
    "stopped",
  );
  // Inspector で文字の書式を変える（色の欄は無い）。
  const form = page.locator('form[data-editor-form="object"]');
  await expect(form.getByLabel("色", { exact: true })).toHaveCount(0);
  await form.getByLabel("警報の帯の文字サイズ", { exact: true }).fill("18");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(
    banner(page).locator("[data-alarm-banner-main]"),
  ).toHaveAttribute("font-size", "18");
});

type Condition = {
  active?: boolean;
  acked?: boolean;
  unavailable?: string | null;
  seq?: number;
};
/** `seq` を orderKey と時刻（09:00:seq）に使う。 */
function condition({
  active = false,
  acked = true,
  unavailable = null,
  seq = 0,
}: Condition) {
  return {
    active,
    occurrence: active || !acked ? `occ-${seq}` : null,
    recurrence: 0,
    acked,
    timer: null,
    unavailable,
    reportedUnavailable: unavailable,
    orderKey: active || !acked ? { generation: 1, seq } : null,
    occurredAtMs: active || !acked ? Date.UTC(2026, 10, 17, 0, 0, seq) : null,
    observation: null,
  };
}
const display = (name: string, message: string, severity: string) => ({
  name,
  message,
  severity,
  limitLabel: null,
});
let generation = 0;
function snapshot(
  conditions: Record<string, Condition>,
  {
    projectId = PROJECT,
    engineUnavailable = null as string | null,
    message = "温度 異常高",
  } = {},
) {
  generation += 1;
  return {
    monitored: { projectId },
    applied: {
      projectId,
      projectRevision: 1,
      appliedAtMs: 1,
      displays: {
        [HH]: display("T-01 温度 HH", message, "high"),
        [H]: display("T-01 温度 H", "温度 高", "high"),
        [PUMP]: display("P-01 停止", "ポンプ停止", "low"),
      },
    },
    engine: {
      session: { id: `session-${generation}`, generation },
      seq: 1,
      unavailable: engineUnavailable,
      conditions: Object.fromEntries(
        Object.entries(conditions).map(([id, value]) => [id, condition(value)]),
      ),
    },
    status: "running",
    pendingConditionChanges: false,
    pendingDisplayChanges: false,
    historyWriteFailure: null,
    rereadFailure: null,
  };
}

test("a banner chooses one alarm from the mocked alarm feed", async ({
  page,
}) => {
  await mockAlarmEntry(page);
  await openSample(page, {
    ...sample,
    alarms: { ...sample.alarms, blinkUnacked: true },
  });
  await addBanner(page);
  const name = (text: string) =>
    expect(banner(page)).toHaveAccessibleName(`最新の警報: ${text}`);
  const setSnapshot = (value: unknown) =>
    page.evaluate(
      (value) => (window as any).__bantoAlarmMock.setSnapshot(value),
      value,
    );

  // モックの既定は未適用で停止中。
  await name("警報 停止中（未適用）");

  // 警報なしでも、condition 単位の評価不能は件数と主な理由を添える。
  await setSnapshot(
    snapshot({
      [HH]: { unavailable: "initialValue" },
      [H]: { unavailable: "stale" },
      [PUMP]: { unavailable: "stale" },
    }),
  );
  await name("警報なし ／ 評価不能 3 件（更新停止）");
  await expect(banner(page)).toHaveAttribute("data-alarm-banner-kind", "none");
  await expect(
    banner(page).locator("[data-alarm-banner-unavailable]"),
  ).toContainText("評価不能 3 件（更新停止）");

  // 同じ定義なら、H が新しくても上位の限界の HH を出す。
  await setSnapshot(
    snapshot({
      [HH]: { active: true, acked: false, seq: 1 },
      [H]: { active: true, acked: false, seq: 2 },
    }),
  );
  await name(
    "11/17 09:00:01 T-01 温度 HH 温度 異常高 ／ 警報 2 件（未確認 2 件）",
  );
  await expect(banner(page)).toHaveAttribute(
    "data-alarm-state",
    "activeUnacked",
  );
  await expect(banner(page)).toHaveAttribute("data-alarm-severity", "high");
  await expect(banner(page).locator("[data-alarm-unacked-frame]")).toHaveCount(
    1,
  );
  // blinkUnacked のときだけ点滅し、「動きを減らす」では止める。
  const animation = () =>
    banner(page).evaluate((node) => getComputedStyle(node).animationName);
  await expect.poll(animation).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(animation).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // 未確認を確認済みより先に出す（severity が低くても）。
  await setSnapshot(
    snapshot({
      [HH]: { active: true, acked: true, seq: 3 },
      [PUMP]: { active: true, acked: false, seq: 1 },
    }),
  );
  await name("11/17 09:00:01 P-01 停止 ポンプ停止 ／ 警報 2 件（未確認 1 件）");
  await expect(banner(page)).toHaveAttribute("data-alarm-severity", "low");

  // 確認済みどうしなら severity の高い順、同じなら新しい順。
  await setSnapshot(
    snapshot({
      [HH]: { active: true, acked: true, seq: 1 },
      [PUMP]: { active: true, acked: true, seq: 9 },
    }),
  );
  await name(
    "11/17 09:00:01 T-01 温度 HH 温度 異常高 ／ 警報 2 件（未確認 0 件）",
  );
  await expect.poll(animation).toBe("none");
  await expect(banner(page).locator("[data-alarm-unacked-frame]")).toHaveCount(
    0,
  );
  await setSnapshot(
    snapshot({
      [H]: { active: true, acked: true, seq: 4 },
      [HH]: { active: false, acked: true },
      [PUMP]: { active: true, acked: true, seq: 9 },
    }),
  );
  await name("11/17 09:00:04 T-01 温度 H 温度 高 ／ 警報 2 件（未確認 0 件）");

  // 復帰・未確認は「復帰」を添え、評価不能も添える。
  await setSnapshot(
    snapshot({
      [PUMP]: { active: false, acked: false, seq: 5 },
      [HH]: { unavailable: "bad" },
    }),
  );
  await name(
    "復帰 11/17 09:00:05 P-01 停止 ポンプ停止 ／ 警報 1 件（未確認 1 件） ／ 評価不能 1 件（不良）",
  );
  await expect(banner(page)).toHaveAttribute(
    "data-alarm-state",
    "returnedUnacked",
  );

  // 長いメッセージは幅に収まるよう「…」で省略し、aria-label には全文を入れる。
  const long = "温度が上限を超えました。".repeat(20);
  await setSnapshot(
    snapshot(
      { [HH]: { active: true, acked: false, seq: 6 } },
      { message: long },
    ),
  );
  await name(`11/17 09:00:06 T-01 温度 HH ${long} ／ 警報 1 件（未確認 1 件）`);
  await expect(banner(page).locator("[data-alarm-banner-main]")).toHaveText(
    /…$/,
  );

  // Engine 単位の評価不能のあいだは、選んだ 1 件を出さずに理由を出す。
  await setSnapshot(
    snapshot(
      { [HH]: { active: true, acked: false, seq: 7 } },
      { engineUnavailable: "disconnected" },
    ),
  );
  await name("警報 監視できていません（未接続）");
  await expect(banner(page)).toHaveAttribute(
    "data-alarm-banner-kind",
    "unmonitored",
  );

  // 別の Project を監視している snapshot。
  await setSnapshot(
    snapshot(
      { [HH]: { active: true, acked: false, seq: 8 } },
      { projectId: "0199f200-0000-7000-8000-0000000000ff" },
    ),
  );
  await name("警報 別の Project を監視中です");
  await expect(banner(page)).toHaveAttribute(
    "data-alarm-banner-kind",
    "otherProject",
  );
});
