import { fileCommand, selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("duplicate placements, undo/redo and stacking order survive file round-trip", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "ポンプを追加" }).click();
  await page.getByRole("button", { name: "選択図形を複製" }).click();
  await expect(svg.locator("[data-symbol-id]")).toHaveCount(2);
  const copyId = await svg
    .locator("[data-object-id]")
    .last()
    .getAttribute("data-object-id");
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(svg.locator("[data-symbol-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "やり直す", exact: true }).click();
  await expect(svg.locator("[data-symbol-id]")).toHaveCount(2);
  const copy = svg.locator(`[data-object-id="${copyId}"]`);
  await copy.click();
  await page.getByRole("button", { name: "最背面へ", exact: true }).click();
  await expect(svg.locator("[data-object-id]").first()).toHaveAttribute(
    "data-object-id",
    copyId!,
  );
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(svg.locator("[data-object-id]").last()).toHaveAttribute(
    "data-object-id",
    copyId!,
  );
  await page.getByRole("button", { name: "やり直す", exact: true }).click();
  await expect(svg.locator("[data-object-id]").first()).toHaveAttribute(
    "data-object-id",
    copyId!,
  );
  const downloading = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const downloaded = await downloading;
  const json = await readFile((await downloaded.path())!, "utf8"),
    saved = JSON.parse(json);
  expect(saved.symbols).toHaveLength(1);
  expect(saved.manifest.projectRevision).toBe(8);
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "history.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "やり直す", exact: true }),
  ).toBeDisabled();
  await expect(svg.locator("[data-object-id]").first()).toHaveAttribute(
    "data-object-id",
    copyId!,
  );
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(page.getByRole("group", { name: "編集履歴" })).toHaveCount(0);
});
test("keyboard history ignores inputs, clears redo on a new edit and is inactive in preview", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "Rectangle を追加" }).click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  const x = page.getByLabel("X", { exact: true });
  await x.focus();
  await page.keyboard.press("Control+z");
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  await page.getByRole("button", { name: "Rectangle を追加" }).focus();
  await page.keyboard.press("Control+d");
  await expect(svg.locator("[data-object-id]")).toHaveCount(5);
  await page.keyboard.press("Control+z");
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  await page.keyboard.press("Control+Shift+z");
  await expect(svg.locator("[data-object-id]")).toHaveCount(5);
  await page.keyboard.press("Control+z");
  await page.getByRole("button", { name: "Text を追加" }).click();
  await expect(
    page.getByRole("button", { name: "やり直す", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page.keyboard.press("Control+z");
  await expect(svg.locator("[data-object-id]")).toHaveCount(5);
});
test("edit shortcuts follow the shared guards for repeat, IME and modal layers", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  const add = page.getByRole("button", { name: "Rectangle を追加" });
  await add.click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  await add.focus();
  // 押し続けの複製・IME 変換中のキーは操作しない。
  for (const flags of [
    { key: "d", repeat: true },
    { key: "d", isComposing: true },
    { key: "z", keyCode: 229 },
  ])
    await add.dispatchEvent("keydown", { ctrlKey: true, ...flags });
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  // 元に戻すは押し続けでも効く。
  await add.dispatchEvent("keydown", { key: "z", ctrlKey: true, repeat: true });
  await expect(svg.locator("[data-object-id]")).toHaveCount(3);
  await page.keyboard.press("Control+y");
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  // モーダルの表示中は背後の編集履歴を動かさない。
  await page.keyboard.press("F1");
  const help = page.getByRole("dialog");
  await expect(help).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
});
test("dispatcher shortcuts skip consumed keys, accept checkboxes, work beside a context menu and recover after a modal", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  const add = page.getByRole("button", { name: "Rectangle を追加" });
  await add.click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  const objects = svg.locator("[data-object-id]");
  await expect(objects).toHaveCount(4);
  // 先に preventDefault された keydown は操作しない。
  await add.evaluate((el) => {
    el.addEventListener("keydown", (event) => event.preventDefault(), {
      once: true,
    });
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(objects).toHaveCount(4);
  // チェックボックスは入力欄に数えない。
  await page.getByLabel("グリッド表示", { exact: true }).focus();
  await page.keyboard.press("Control+z");
  await expect(objects).toHaveCount(3);
  await page.keyboard.press("Control+y");
  await expect(objects).toHaveCount(4);
  // Ctrl と Cmd（Meta）のどちらでも効く（従来どおり）。
  await add.dispatchEvent("keydown", { key: "z", metaKey: true });
  await expect(objects).toHaveCount(3);
  await add.dispatchEvent("keydown", { key: "y", metaKey: true });
  await expect(objects).toHaveCount(4);
  const openMenu = async () => {
    await objects.nth(1).click({ button: "right" });
    await expect(
      page.getByRole("menu").getByRole("menuitem").first(),
    ).toBeFocused();
  };
  // コンテキストメニューを開いたままでも F1／F2・Ctrl+N／O は効く。
  await openMenu();
  expect(
    await page
      .getByRole("menu")
      .getByRole("menuitem")
      .first()
      .evaluate((el) =>
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "F2",
            bubbles: true,
            cancelable: true,
          }),
        ),
      ),
  ).toBe(false);
  await page.keyboard.press("Escape");
  await openMenu();
  await page.keyboard.press("F1");
  const help = page.getByRole("dialog");
  await expect(help).toBeVisible();
  // メニューとヘルプが同時に残っていても Ctrl+S・Shift+Ctrl+S で書き出せる。
  for (const keys of ["Control+s", "Control+Shift+s"]) {
    const download = page.waitForEvent("download");
    await page.keyboard.press(keys);
    await download;
  }
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(help).toBeVisible();
  // 移行前から、メニューはヘルプの裏で開いたまま残り、最初の Esc はメニューを閉じる。
  // （残課題。ここでは今の動きを固定せず、2 回の Esc の後に両方が閉じることだけを見る。）
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(help).toHaveCount(0);
  // モーダルを閉じた後は編集のショートカットが戻る。
  await add.focus();
  await page.keyboard.press("Control+z");
  await expect(objects).toHaveCount(3);
  await page.keyboard.press("Control+y");
  await expect(objects).toHaveCount(4);
  await openMenu();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+o");
  await chooser;
  // 上の Ctrl+S で書き出し済みなので、置換の確認が出るよう変更を足す。
  await add.click();
  await expect(objects).toHaveCount(5);
  await openMenu();
  await page.keyboard.press("Control+n");
  const replacement = page.getByRole("dialog", {
    name: "Project を置き換えますか",
    exact: true,
  });
  await expect(replacement).toBeVisible();
  // 置換の確認の表示中も Ctrl+S で書き出せる（書き出したファイルを確かめてから破棄する流れ）。
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  await download;
  await expect(replacement).toBeVisible();
});
