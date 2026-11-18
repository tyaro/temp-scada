import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/process.project.json" with { type: "json" };
import {
  mainCanvas,
  openAlarmDefinitions,
  selectPanel,
} from "./helpers/designer";
import { openProject } from "./helpers/project-files";

// 警報の小札。仕様: docs/design/graphics/alarm-badge.md
const PROJECT = sample.manifest.projectId;
const TEMP = sample.alarms.definitions[0].id;
const HH = `${TEMP}:hh`;

const palette = (page: Page) =>
  page.getByRole("region", { name: "部品パレット", exact: true });
const status = (page: Page) => page.getByTestId("project-status");
const badge = (page: Page) =>
  mainCanvas(page).getByRole("img", { name: /^警報の小札 / });

/**
 * テスト用のエントリーだけにモックの警報 feed を渡す（製品には global の hook が無い）。
 * 操作する関数は `window.__bantoAlarmMock`。
 */
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
async function addBadge(page: Page) {
  await selectPanel(page, "部品");
  await palette(page)
    .getByRole("searchbox", { name: "部品を検索" })
    .fill("警報");
  await palette(page)
    .getByRole("button", { name: "警報の小札を追加", exact: true })
    .click();
  await expect(badge(page)).toHaveCount(1);
}

test("a badge is unknown without the Engine, and is guarded by its definition", async ({
  page,
}) => {
  // 警報の定義が無い Project では追加できない。
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await palette(page)
    .getByRole("searchbox", { name: "部品を検索" })
    .fill("警報");
  const add = palette(page).getByRole("button", {
    name: "警報の小札を追加",
    exact: true,
  });
  await expect(add).toBeDisabled();
  await expect(add).toHaveAttribute("title", /警報の定義がありません/);
  await expect(palette(page)).toContainText("警報の定義がありません");

  // 定義のある Project では最初の定義の HH を指し、Engine が無いので「不明」。
  await openSample(page);
  await addBadge(page);
  await expect(badge(page)).toHaveAccessibleName(
    "警報の小札 T-01 温度 HH: 不明（警報の状態を受け取っていません）",
  );
  await expect(badge(page)).toHaveAttribute("data-alarm-state", "unknown");
  await expect(badge(page)).toContainText("HH");

  // Inspector で指す先と文字を変える。
  const form = page.locator('form[data-editor-form="object"]');
  await form
    .getByLabel("警報の小札が指す警報", { exact: true })
    .selectOption({ label: "T-01 温度 H" });
  await form.getByLabel("警報の小札の文字", { exact: true }).fill("温H");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(badge(page)).toHaveAccessibleName(
    /^警報の小札 T-01 温度 H: 不明/,
  );
  await expect(badge(page)).toContainText("温H");

  // 小札が指す定義の削除は、使用中の小札を示して止める。
  await openAlarmDefinitions(page);
  await page
    .getByRole("table", { name: "警報の定義", exact: true })
    .getByRole("button", { name: "T-01 温度 を選ぶ", exact: true })
    .click();
  await page.getByRole("button", { name: "警報を削除", exact: true }).click();
  await expect(status(page)).toContainText("この警報は警報の小札で使用中です");
  await expect(
    page
      .getByRole("table", { name: "警報の定義", exact: true })
      .locator("tbody tr"),
  ).toHaveCount(sample.alarms.definitions.length);
});

type Condition = {
  active: boolean;
  acked: boolean;
  unavailable?: string | null;
};
function condition({ active, acked, unavailable = null }: Condition) {
  return {
    active,
    occurrence: active || !acked ? "occ-1" : null,
    recurrence: 0,
    acked,
    timer: null,
    unavailable,
    reportedUnavailable: unavailable,
    orderKey: null,
    occurredAtMs: null,
    observation: null,
  };
}
function snapshot(
  generation: number,
  seq: number,
  value: Condition,
  projectId = PROJECT,
) {
  return {
    monitored: { projectId },
    applied: {
      projectId,
      projectRevision: 1,
      appliedAtMs: 1,
      displays: {
        [HH]: {
          name: "T-01 温度",
          message: "温度 異常高",
          severity: "high",
          limitLabel: "HH",
        },
      },
    },
    engine: {
      session: { id: `session-${generation}`, generation },
      seq,
      unavailable: null,
      conditions: { [HH]: condition(value) },
    },
    status: "running",
    pendingConditionChanges: false,
    pendingDisplayChanges: false,
    pendingUnknown: false,
    historyWriteFailure: null,
    rereadFailure: null,
  };
}

test("a badge follows the mocked alarm feed through every state", async ({
  page,
}) => {
  await mockAlarmEntry(page);
  // 未確認の点滅を有効にした Project で確かめる。
  await openSample(page, {
    ...sample,
    alarms: { ...sample.alarms, blinkUnacked: true },
  });
  await addBadge(page);
  const name = (text: string) =>
    expect(badge(page)).toHaveAccessibleName(
      `警報の小札 T-01 温度 HH: ${text}`,
    );
  const setSnapshot = (value: unknown) =>
    page.evaluate(
      (value) => (window as any).__bantoAlarmMock.setSnapshot(value),
      value,
    );
  let seq = 1;
  const emit = (value: Condition, engineUnavailable: string | null = null) =>
    page.evaluate((change) => (window as any).__bantoAlarmMock.emit(change), {
      session: { id: "session-1", generation: 1 },
      seq: ++seq,
      conditions: { [HH]: condition(value) },
      engineUnavailable,
    });

  await setSnapshot(snapshot(1, seq, { active: false, acked: true }));
  await name("正常");
  // ヘッダーの警報表示もモックで動く。
  await expect(page.getByText("警報: 監視中", { exact: true })).toBeVisible();

  await emit({ active: true, acked: false });
  await name("未確認（発生中）");
  await expect(badge(page).locator("[data-alarm-unacked-frame]")).toHaveCount(
    1,
  );
  // blinkUnacked のときだけ点滅し、「動きを減らす」では止める。
  const animation = () =>
    badge(page).evaluate((node) => getComputedStyle(node).animationName);
  await expect.poll(animation).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(animation).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await emit({ active: true, acked: true });
  await name("発生中");
  await expect.poll(animation).toBe("none");
  await expect(badge(page).locator("[data-alarm-unacked-frame]")).toHaveCount(
    0,
  );

  await emit({ active: true, acked: true, unavailable: "stale" });
  await name("発生中・評価不能");
  await expect(badge(page).locator("[data-alarm-question]")).toHaveCount(1);

  await emit({ active: false, acked: false });
  await name("復帰・未確認");

  await emit({ active: false, acked: true });
  await name("正常");

  await emit({ active: false, acked: true, unavailable: "bad" });
  await name("評価不能");

  // Engine 単位の評価不能は「不明」。
  await emit({ active: false, acked: true }, "disconnected");
  await name("不明（監視できていません）");
  await expect(badge(page)).toHaveAttribute("data-alarm-state", "unknown");

  // 別の Project を監視している snapshot では「不明」。
  await setSnapshot(
    snapshot(
      2,
      1,
      { active: true, acked: false },
      "0199f200-0000-7000-8000-0000000000ff",
    ),
  );
  await name("不明（別の Project を監視中です）");

  // 監視中の Project に戻れば状態が出る。
  await setSnapshot(snapshot(3, 1, { active: true, acked: false }));
  await name("未確認（発生中）");

  // 止まった Engine の状態コードは、ヘッダーで日本語の文言にして出す。
  await setSnapshot({
    ...snapshot(4, 1, { active: false, acked: true }),
    status: "noConditions",
  });
  await expect(
    page.getByText("警報: 警報の定義がありません", { exact: true }),
  ).toBeVisible();
  // Engine が自ら止まった理由（認証の失効）を「停止」と区別して出す。
  await setSnapshot({
    ...snapshot(5, 1, { active: false, acked: true }),
    status: "authExpired",
  });
  await expect(
    page.getByText("警報: Hubの認証が切れました（接続し直すと再開します）", {
      exact: true,
    }),
  ).toBeVisible();

  // 監視中の保存済みファイルが読めないときは「監視中」と言わない。
  await setSnapshot({
    ...snapshot(6, 1, { active: false, acked: true }),
    pendingUnknown: true,
  });
  await expect(
    page.getByText("警報: 保存済みファイルを確認できません", { exact: true }),
  ).toBeVisible();
});

test("a badge copies and pastes onto the same alarm, and is refused where the alarm is missing", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSample(page);
  await addBadge(page);
  const menu = async (name: string) => {
    await page
      .getByRole("menubar")
      .getByRole("menuitem", { name: "編集", exact: true })
      .click();
    await page
      .getByRole("menu", { name: "編集", exact: true })
      .getByRole("menuitem", { name, exact: true })
      .click();
  };
  await menu("コピー");
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(text).project.alarms.definitions).toHaveLength(1);
  await menu("貼り付け");
  await expect(badge(page)).toHaveCount(2);
  await expect(badge(page).nth(1)).toHaveAccessibleName(
    /^警報の小札 T-01 温度 HH: 不明/,
  );

  // 指す警報の定義が無い Project へは、警報の名前を示して貼り付けない。
  const other = structuredClone(sample) as any;
  other.manifest.projectId = "0199f6a1-0000-7000-8000-0000000009ff";
  other.alarms.definitions = other.alarms.definitions.filter(
    (definition: { id: string }) => definition.id !== TEMP,
  );
  await openSample(page, other);
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await menu("貼り付け");
  await expect(
    page
      .getByText(/警報の小札が指す警報「T-01 温度 HH」の定義がありません/)
      .first(),
  ).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
});
