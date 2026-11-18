import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/process.project.json" with { type: "json" };
import { fileCommand } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

// 警報の端末設定の窓。仕様: docs/design/runtime/alarm-terminal-settings.md §2・§5・§7
test.use({ timezoneId: "Asia/Tokyo" });

const PROJECT = sample.manifest.projectId;

/** alarm-list.spec.ts と同じく、テスト用のエントリーだけにモックの警報 feed を渡す。 */
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

async function openSample(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await openProject(page, {
    name: "process.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
}

/** モックの操作（`window.__bantoAlarmMock.<body>`。`arg` を渡せる）。 */
const mock = <T>(page: Page, body: string, arg?: unknown) =>
  page.evaluate(
    ([body, arg]) =>
      new Function("mock", "arg", `return mock.${body}`)(
        (window as any).__bantoAlarmMock,
        arg,
      ),
    [body, arg] as const,
  ) as Promise<T>;

let engineSeq = 0;
/** 動いている Engine（警報は無い）。ブザーと音の状態だけを変える。 */
function running(
  buzzer: "ringing" | "quiet",
  buzzerSound: { kind: string; fallback: string | null } = {
    kind: "default",
    fallback: null,
  },
) {
  return {
    monitored: { projectId: PROJECT },
    applied: {
      projectId: PROJECT,
      projectRevision: sample.manifest.projectRevision,
      appliedAtMs: 1,
      displays: {},
    },
    engine: {
      session: { id: "session-1", generation: 1 },
      // 画面の mirror は古い連番の snapshot を捨てるので、取り直すたびに進める。
      seq: (engineSeq += 10),
      unavailable: null,
      conditions: {},
    },
    status: "running",
    pendingConditionChanges: false,
    pendingDisplayChanges: false,
    pendingUnknown: false,
    historyWriteFailure: null,
    rereadFailure: null,
    buzzer,
    buzzerSound,
  };
}

const VIEW = {
  retention: { kind: "days", days: 365, count: 1_000_000 },
  reread: {
    intervalSec: 10,
    timeoutSec: 5,
    failureLimitSec: 30,
    reconnectFailures: 3,
  },
  sound: { kind: "default" },
  soundFallback: null,
  warnings: [] as string[],
  retentionStatus: {
    eventCount: 1234,
    oldestAtMs: Date.UTC(2026, 0, 2, 3, 4, 5),
  },
};

const settings = (page: Page) =>
  page.getByRole("dialog", { name: "警報の端末設定" });
async function openFromMenu(page: Page) {
  await fileCommand(page, "警報の端末設定…");
  await expect(settings(page)).toBeVisible();
}

test("the File menu opens the terminal settings, saves retention and reread together and refuses out-of-range values", async ({
  page,
}) => {
  await mockAlarmEntry(page);
  await openSample(page);
  await mock(page, "setAlarmSettings(arg)", {
    ...VIEW,
    warnings: ["reread"],
  });
  await openFromMenu(page);
  const dialog = settings(page);

  await expect(dialog.locator("[data-alarm-retention-status]")).toHaveText(
    "いまのイベント 1,234 件・いちばん古いイベント 2026/1/2 12:04:05",
  );
  await expect(dialog).toContainText(
    "いま続いている警報のイベントは、期限を過ぎても消さずに残します。",
  );
  await expect(dialog).toContainText("保存するとすぐに使われます");
  await expect(dialog.locator("[data-alarm-settings-warning]")).toHaveText(
    "値の読み直しの設定が範囲外だったため、4 つとも既定値に戻しました。",
  );
  await expect(dialog.getByLabel("保持の日数（日）")).toHaveValue("365");

  // 範囲外は画面で示し、保存を押せない（host にも送らない）。
  const save = dialog.getByRole("button", { name: "保存", exact: true });
  await dialog.getByLabel("保持の日数（日）").fill("0");
  await expect(dialog).toContainText("1〜3,650 日で入れてください。");
  await expect(save).toBeDisabled();
  await dialog.getByLabel("保持の日数（日）").fill("30");
  await dialog.getByLabel("読み直しの周期（秒）").fill("4");
  await expect(dialog).toContainText("1〜4 秒（周期以下）で入れてください。");
  await expect(save).toBeDisabled();
  await dialog.getByLabel("1 回の期限（秒）").fill("3");
  await expect(save).toBeEnabled();

  // 件数に切り替えても日数は残し、まとめて保存する。
  await dialog.getByRole("radio", { name: "件数で残す" }).check();
  await dialog.getByLabel("保持の件数（件）").fill("20000");
  await save.click();
  await expect(dialog.locator("[data-alarm-settings-saved]")).toContainText(
    "保存しました。読み直しの値はすぐに使われ",
  );
  expect(await mock(page, "alarmSettingsRequests()")).toEqual([
    {
      retention: { kind: "count", days: 30, count: 20_000 },
      reread: {
        intervalSec: 4,
        timeoutSec: 3,
        failureLimitSec: 30,
        reconnectFailures: 3,
      },
    },
  ]);

  // 範囲外の値を残したまま種類を切り替えると、隠れる側は最後に読んだ値へ戻り、
  // 見えない誤りで保存を押せなくならない。
  await dialog.getByRole("radio", { name: "日数で残す" }).check();
  await dialog.getByLabel("保持の日数（日）").fill("0");
  await expect(save).toBeDisabled();
  await dialog.getByRole("radio", { name: "件数で残す" }).check();
  await expect(save).toBeEnabled();
  await dialog.getByRole("radio", { name: "日数で残す" }).check();
  await expect(dialog.getByLabel("保持の日数（日）")).toHaveValue("30");
  // 保存した値で表示し直す（警告は消える）。
  await expect(dialog.locator("[data-alarm-settings-warning]")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(settings(page)).toHaveCount(0);
  await openFromMenu(page);
  await expect(settings(page).getByLabel("保持の件数（件）")).toHaveValue(
    "20000",
  );
});

test("the buzzer sound is imported, reset and tested on the spot, and the fallback is shown", async ({
  page,
}) => {
  await mockAlarmEntry(page);
  await openSample(page);
  await mock(page, "setSnapshot(arg)", running("quiet"));
  await openFromMenu(page);
  const dialog = settings(page);
  const sound = dialog.locator("[data-alarm-sound]");
  const choose = dialog.getByRole("button", { name: "ファイルを選ぶ" });
  const reset = dialog.getByRole("button", { name: "既定に戻す" });
  const testSound = dialog.getByRole("button", { name: "試しに鳴らす" });
  await expect(sound).toHaveText("いまの音: 既定のビープ");
  await expect(reset).toBeDisabled();

  // 取り消しは変えない。拒否は host の理由で示す。
  await choose.click();
  await expect(sound).toHaveText("いまの音: 既定のビープ");
  await mock(page, "nextSoundImport(arg)", { reason: "invalidSound:notWav" });
  await choose.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "この音は使えません（WAV ファイルではありません）。",
  );
  await mock(page, "nextSoundImport(arg)", { name: "chime.wav" });
  await choose.click();
  await expect(sound).toHaveText("いまの音: 取り込んだファイル「chime.wav」");
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  await testSound.click();
  await expect(dialog.locator("[data-alarm-sound-done]")).toHaveText(
    "いまの設定の音を一度鳴らしました。",
  );
  expect(await mock(page, "soundTests()")).toBe(1);

  await reset.click();
  await expect(sound).toHaveText("いまの音: 既定のビープ");

  // 鳴っている間は試しに鳴らせない。
  await mock(page, "setSnapshot(arg)", running("ringing"));
  await expect(testSound).toBeDisabled();
  await expect(dialog.locator("[data-alarm-sound-ringing]")).toBeVisible();
  await mock(page, "setSnapshot(arg)", running("quiet"));
  await expect(testSound).toBeEnabled();
  await page.keyboard.press("Escape");

  // 代替: ヘッダー・一覧の窓・端末設定の窓に示す（§5）。
  await mock(page, "setAlarmSettings(arg)", {
    ...VIEW,
    sound: {
      kind: "custom",
      name: "chime.wav",
      size: 1024,
      hash: "0".repeat(64),
    },
    soundFallback: "fileUnreadable",
  });
  await mock(
    page,
    "setSnapshot(arg)",
    running("quiet", { kind: "custom", fallback: "fileUnreadable" }),
  );
  const notice = "設定の音を鳴らせないため、既定の音で鳴らしています";
  await expect(page.locator("[data-alarm-sound-fallback]")).toHaveText(notice);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page.getByRole("button", { name: "アラーム一覧", exact: true }).click();
  const list = page.getByRole("dialog", { name: "アラーム一覧" });
  await expect(list.locator("[data-alarm-sound-fallback]")).toHaveText(notice);

  // 一覧の窓の「端末設定」からも開き、一覧の上に重ねる。
  await list.getByRole("button", { name: "端末設定", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-alarm-sound-fallback]")).toHaveText(
    "取り込んだファイルが無いか読めないため、既定のビープで鳴らしています。",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(list).toBeVisible();
});

test("without permission the terminal settings can be read but not changed", async ({
  page,
}) => {
  await mockAlarmEntry(page);
  await openSample(page);
  await mock(page, "setSnapshot(arg)", running("quiet"));
  await mock(page, "refuseAlarmSettings(arg)", "forbidden");
  await openFromMenu(page);
  const dialog = settings(page);
  await expect(dialog.getByLabel("保持の日数（日）")).toHaveValue("365");
  await dialog.getByLabel("保持の日数（日）").fill("30");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "端末設定の変更は Admin だけが行えます。",
  );
  await expect(dialog.locator("[data-alarm-settings-locked]")).toContainText(
    "値は読めますが変更できません。",
  );
  await expect(dialog.getByLabel("保持の日数（日）")).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "ファイルを選ぶ" }),
  ).toBeDisabled();
  // 試しに鳴らすは権限が要らない。
  await dialog.getByRole("button", { name: "試しに鳴らす" }).click();
  await expect(dialog.locator("[data-alarm-sound-done]")).toBeVisible();
  expect(await mock(page, "soundTests()")).toBe(1);
});

test("the browser version cannot open the terminal settings and says why", async ({
  page,
}) => {
  await openSample(page);
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "ファイル", exact: true })
    .click();
  await expect(
    page
      .getByRole("menu", { name: "ファイル", exact: true })
      .getByRole("menuitem", { name: "警報の端末設定…（デスクトップ版のみ）" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page.getByRole("button", { name: "アラーム一覧", exact: true }).click();
  const list = page.getByRole("dialog", { name: "アラーム一覧" });
  await expect(
    list.getByRole("button", { name: "端末設定", exact: true }),
  ).toBeDisabled();
  await expect(list).toContainText("端末設定はデスクトップ版だけで扱えます");
});

test("a reply from before the window was closed does not touch the reopened form or its busy state", async ({
  page,
}) => {
  await mockAlarmEntry(page);
  await openSample(page);
  const days = () => settings(page).getByLabel("保持の日数（日）");
  await mock(page, "setAlarmSettings(arg)", {
    ...VIEW,
    retention: { ...VIEW.retention, days: 100 },
  });
  await mock(page, "holdAlarmSettingsReads()");

  // 読込み A を待たせたまま閉じ、開き直した読込み B も待たせる。
  await openFromMenu(page);
  await page.keyboard.press("Escape");
  await expect(settings(page)).toBeHidden();
  await mock(page, "setAlarmSettings(arg)", {
    ...VIEW,
    retention: { ...VIEW.retention, days: 200 },
  });
  await openFromMenu(page);

  // 古い A の終わりは、読込み中の B の busy を解かず、値も入れない。
  await mock(page, "releaseAlarmSettingsRead(0)");
  await expect(days()).toBeDisabled();
  await expect(days()).not.toHaveValue("100");
  await mock(page, "releaseAlarmSettingsRead(1)");
  await expect(days()).toHaveValue("200");
  await expect(days()).toBeEnabled();
});

test("a reply from before the window was closed does not overwrite what was typed after reopening", async ({
  page,
}) => {
  await mockAlarmEntry(page);
  await openSample(page);
  const days = () => settings(page).getByLabel("保持の日数（日）");
  await mock(page, "setAlarmSettings(arg)", {
    ...VIEW,
    retention: { ...VIEW.retention, days: 100 },
  });
  await mock(page, "holdAlarmSettingsReads()");
  await openFromMenu(page);
  await page.keyboard.press("Escape");
  await expect(settings(page)).toBeHidden();
  await mock(page, "setAlarmSettings(arg)", {
    ...VIEW,
    retention: { ...VIEW.retention, days: 200 },
  });
  await openFromMenu(page);

  // B を先に返して入力し、そのあとで A を初めて返す。
  await mock(page, "releaseAlarmSettingsRead(1)");
  await expect(days()).toHaveValue("200");
  await days().fill("250");
  await mock(page, "releaseAlarmSettingsRead(0)");
  await expect(days()).toHaveValue("250");
  await expect(days()).toBeEnabled();
  await expect(
    settings(page).getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
});
