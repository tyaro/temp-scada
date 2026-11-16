import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/process.project.json" with { type: "json" };
import { mainCanvas } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

// アラーム一覧の窓。仕様: docs/design/graphics/alarm-list.md
test.use({ timezoneId: "Asia/Tokyo" });

const PROJECT = sample.manifest.projectId;
const TEMP = sample.alarms.definitions[0].id;
const PUMP = sample.alarms.definitions[1].id;
const HH = `${TEMP}:hh`;
const H = `${TEMP}:h`;
const START = sample.operatorFrame.startScreenId;
const ALARM_BUTTON = "0199f6ab-0000-7000-8000-000000000990";

/** alarm-banner.spec.ts と同じく、テスト用のエントリーだけにモックの警報 feed を渡す。 */
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

function project() {
  const value = structuredClone(sample) as any;
  value.screens
    .find((screen: { id: string }) => screen.id === START)
    .objects.push({
      id: ALARM_BUTTON,
      order: 990,
      x: 700,
      y: 480,
      width: 140,
      height: 40,
      rotation: 0,
      shape: {
        type: "navButton",
        target: { kind: "alarmList" },
        label: "警報一覧",
        fontSize: 16,
        fill: "#334155",
        textColor: "#f8fafc",
      },
    });
  return value;
}

async function openSample(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await openProject(page, {
    name: "process.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project())),
  });
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
}

type Condition = {
  active?: boolean;
  acked?: boolean;
  unavailable?: string | null;
  seq?: number;
  recurrence?: number;
};
function condition({
  active = false,
  acked = true,
  unavailable = null,
  seq = 0,
  recurrence = 0,
}: Condition) {
  const live = active || !acked;
  return {
    active,
    occurrence: live ? `occ-${seq}` : null,
    recurrence,
    acked,
    timer: null,
    unavailable,
    reportedUnavailable: unavailable,
    orderKey: live ? { generation: 1, seq } : null,
    occurredAtMs: live ? Date.UTC(2026, 10, 17, 0, 0, seq) : null,
    observation: null,
  };
}
const display = (name: string, message: string, severity: string) => ({
  name,
  message,
  severity,
  limitLabel: null,
});
let engineSeq = 0;
function snapshot(
  conditions: Record<string, Condition>,
  {
    engineUnavailable = null as string | null,
    projectRevision = sample.manifest.projectRevision,
  } = {},
) {
  return {
    monitored: { projectId: PROJECT },
    applied: {
      projectId: PROJECT,
      projectRevision,
      appliedAtMs: 1,
      displays: {
        [HH]: display("T-01 温度 HH", "温度 異常高", "high"),
        [H]: display("T-01 温度 H", "温度 高", "medium"),
        [PUMP]: display("P-01 停止", "ポンプ停止", "low"),
      },
    },
    engine: {
      session: { id: "session-1", generation: 1 },
      // 画面の mirror は古い連番の snapshot を捨てるので、取り直すたびに進める。
      seq: (engineSeq += 10),
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
const setSnapshot = (page: Page, value: unknown, notify = true) =>
  page.evaluate(
    ([value, notify]) =>
      (window as any).__bantoAlarmMock.setSnapshot(value, { notify }),
    [value, notify] as const,
  );
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "アラーム一覧" });
const row = (page: Page, id: string) =>
  dialog(page).locator(`[data-alarm-row="${id}"]`);

test("the alarm list shows the current alarms and acknowledges the rounds it shows", async ({
  page,
}) => {
  await mockAlarmEntry(page);
  await openSample(page);
  await setSnapshot(
    page,
    snapshot({
      [HH]: { active: true, acked: true, seq: 5 },
      [H]: { active: false, acked: false, seq: 2 },
      [PUMP]: { active: true, acked: false, seq: 1, recurrence: 2 },
    }),
  );
  await page.getByRole("button", { name: "アラーム一覧", exact: true }).click();
  await expect(dialog(page)).toBeVisible();

  // 未確認を上に（severity → 新しい順）、状態は文字で分ける。
  const rows = dialog(page).locator("[data-alarm-row]");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-alarm-row", H);
  await expect(rows.nth(1)).toHaveAttribute("data-alarm-row", PUMP);
  await expect(rows.nth(2)).toHaveAttribute("data-alarm-row", HH);
  await expect(row(page, H)).toContainText("復帰・未確認");
  await expect(row(page, PUMP)).toContainText("未確認（発生中）");
  await expect(row(page, HH)).toContainText("発生中");
  await expect(row(page, HH).getByRole("checkbox")).toBeDisabled();

  // 選んで ACK: 見ている回 (conditionId, occurrence, recurrence) を送る。
  await row(page, PUMP).getByRole("checkbox").check();
  await dialog(page)
    .getByRole("button", { name: "選んだ警報を ACK", exact: true })
    .click();
  await expect(row(page, PUMP)).toContainText("発生中");
  await expect(row(page, PUMP).locator("[data-alarm-row-result]")).toHaveText(
    "受理",
  );
  expect(
    await page.evaluate(() => (window as any).__bantoAlarmMock.ackRequests()),
  ).toEqual([[{ conditionId: PUMP, occurrence: "occ-1", recurrence: 2 }]]);

  // 画面が古い回を見ているあいだに再発生 → 「別の回」で最新を取り直す。
  await setSnapshot(
    page,
    snapshot({
      [HH]: { active: true, acked: true, seq: 5 },
      [H]: { active: true, acked: false, seq: 7, recurrence: 1 },
      [PUMP]: { active: true, acked: true, seq: 1, recurrence: 2 },
    }),
    false,
  );
  await dialog(page)
    .getByRole("button", { name: "すべて ACK", exact: true })
    .click();
  await expect(row(page, H).locator("[data-alarm-row-result]")).toHaveText(
    "別の回（最新の回を表示しています）",
  );
  await expect(row(page, H)).toContainText("未確認（発生中）");
  await expect(row(page, H)).toContainText("11/17 09:00:07");

  // すべて ACK は画面の最新の未確認の回だけを送る。
  await dialog(page)
    .getByRole("button", { name: "すべて ACK", exact: true })
    .click();
  await expect(row(page, H).locator("[data-alarm-row-result]")).toHaveText(
    "受理",
  );
  const requests = await page.evaluate(() =>
    (window as any).__bantoAlarmMock.ackRequests(),
  );
  expect(requests.slice(1)).toEqual([
    [{ conditionId: H, occurrence: "occ-2", recurrence: 0 }],
    [{ conditionId: H, occurrence: "occ-7", recurrence: 1 }],
  ]);
  await expect(
    dialog(page).getByRole("button", { name: "すべて ACK", exact: true }),
  ).toBeDisabled();

  // 要求ごと拒まれたら理由を出す。
  await page.evaluate(() =>
    (window as any).__bantoAlarmMock.refuseAck("forbidden"),
  );
  await setSnapshot(
    page,
    snapshot({ [PUMP]: { active: true, acked: false, seq: 9 } }),
  );
  await dialog(page)
    .getByRole("button", { name: "すべて ACK", exact: true })
    .click();
  await expect(dialog(page).getByRole("alert")).toHaveText(
    "ACK は Admin だけが行えます。",
  );
});

test("the alarm list explains why it cannot monitor and filters unavailable conditions", async ({
  page,
}) => {
  await mockAlarmEntry(page);
  await openSample(page);
  await page.getByRole("button", { name: "アラーム一覧", exact: true }).click();
  const notices = dialog(page).locator("[data-alarm-list-notice]");
  await expect(notices).toHaveText([
    "警報の Engine が動いていません（未適用）",
  ]);

  // Engine 単位の評価不能: 先頭に理由の行、Normal で評価不能なだけの condition は並べない。
  await setSnapshot(
    page,
    snapshot(
      {
        [PUMP]: { active: true, acked: false, seq: 1 },
        [H]: { unavailable: "stale" },
      },
      { engineUnavailable: "disconnected", projectRevision: 9 },
    ),
  );
  await expect(dialog(page).locator("[data-alarm-engine-row]")).toHaveText(
    "監視できていません（未接続）",
  );
  await expect(dialog(page).locator("[data-alarm-row]")).toHaveCount(1);
  await expect(notices).toHaveText([
    /編集中の Project（revision 1）と適用中の定義（revision 9）が違います/,
  ]);

  // condition 単位の評価不能は別の列に理由を出し、「評価不能だけ」で絞り込める。
  await setSnapshot(
    page,
    snapshot({
      [PUMP]: { active: true, acked: false, seq: 1 },
      [H]: { unavailable: "stale" },
    }),
  );
  await expect(dialog(page).locator("[data-alarm-row]")).toHaveCount(2);
  await expect(row(page, H)).toContainText("更新停止");
  await dialog(page)
    .getByRole("combobox", { name: "アラーム一覧の絞り込み" })
    .selectOption("unavailable");
  await expect(dialog(page).locator("[data-alarm-row]")).toHaveCount(1);
  await expect(row(page, H)).toContainText("正常");

  // 履歴に書けないあいだは ACK できない。
  await setSnapshot(page, {
    ...snapshot({ [PUMP]: { active: true, acked: false, seq: 1 } }),
    historyWriteFailure: { sinceWallMs: 1, unrecordedEvents: 3 },
  });
  await expect(notices.first()).toHaveText(/^履歴に書けません（未記録 3 件）/);
  await expect(
    dialog(page).getByRole("button", { name: "すべて ACK", exact: true }),
  ).toBeDisabled();
});

test("the history tab queries alarm events newest first and continues with the cursor", async ({
  page,
}) => {
  await mockAlarmEntry(page);
  await openSample(page);
  const at = (second: number) => Date.UTC(2026, 10, 17, 0, 0, second);
  const events = Array.from({ length: 105 }, (_, index) => ({
    seq: index + 1,
    sessionId: "session-1",
    event: {
      atMs: at(index % 60),
      conditionId: HH,
      kind: index === 104 ? "occurred" : "returned",
      detail: {
        occurrence: "occ",
        recurrence: 0,
        judgement: {
          limit: 120,
          value: 125.5,
          sourceTimestampMs: at(3),
        },
      },
    },
    display: {
      ...display("T-01 温度 HH", "温度 異常高", "high"),
      limitLabel: "HH",
    },
  }));
  await page.evaluate(
    (events) => (window as any).__bantoAlarmMock.setHistory(events),
    events,
  );
  await page.getByRole("button", { name: "アラーム一覧", exact: true }).click();
  await dialog(page).getByRole("tab", { name: "履歴" }).click();
  const history = dialog(page).getByRole("table", { name: "警報の履歴" });
  const rows = history.locator("[data-alarm-event]");
  await expect(rows).toHaveCount(100);
  await expect(rows.first()).toHaveAttribute("data-alarm-event", "105");
  await expect(rows.first()).toContainText("発生");
  await expect(rows.first()).toContainText("120");
  await expect(rows.first()).toContainText("125.5");
  await expect(rows.first()).toContainText("11/17 09:00:03");
  await dialog(page).getByRole("button", { name: "続きを読む" }).click();
  await expect(rows).toHaveCount(105);
  await expect(
    dialog(page).getByRole("button", { name: "続きを読む" }),
  ).toHaveCount(0);

  // 種類で絞る。
  await dialog(page).getByLabel("種類").selectOption("occurred");
  await dialog(page).getByRole("button", { name: "照会" }).click();
  await expect(rows).toHaveCount(1);
  const queries = await page.evaluate(() =>
    (window as any).__bantoAlarmMock.historyQueries(),
  );
  expect(queries.map((q: { beforeSeq: number | null }) => q.beforeSeq)).toEqual(
    [null, 6, null],
  );
  expect(queries[2].kind).toBe("occurred");
});

test("a nav button and the operator view open the alarm list", async ({
  page,
}) => {
  await mockAlarmEntry(page);
  await openSample(page);
  // プレビューの画面切替ボタンで開く。
  await mainCanvas(page)
    .getByRole("button", { name: "警報一覧：アラーム一覧を開く" })
    .click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page)
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  await expect(dialog(page)).toHaveCount(0);

  // 運転表示の中でも、ボタンとバーから開く（運転表示の中に描く）。
  await page.getByRole("button", { name: "運転表示", exact: true }).click();
  const view = page.getByRole("region", { name: "運転表示" });
  await view
    .locator('[data-operator-region="main"]')
    .getByRole("button", { name: "警報一覧：アラーム一覧を開く" })
    .click();
  await expect(
    view.getByRole("dialog", { name: "アラーム一覧" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(view).toBeVisible();
  await view.getByRole("button", { name: "アラーム一覧", exact: true }).click();
  await expect(
    view.getByRole("dialog", { name: "アラーム一覧" }),
  ).toBeVisible();
});
