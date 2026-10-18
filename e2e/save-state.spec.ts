import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
test("content dirty state follows undo/redo and export requests, not revision or view changes", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
      page.getByRole("button", { name, exact: true }),
    state = page.getByTestId("save-state");
  const leaving = () =>
    page.evaluate(() =>
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    );
  await expect(state).toContainText("サンプルからの変更なし");
  expect(await leaving()).toBe(true);
  await button("編集").click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("2");
  await expect(state).toContainText("サンプルからの変更なし");
  await button("Rectangle を追加").click();
  await expect(state).toContainText("未書き出しの変更あり");
  expect(await leaving()).toBe(false);
  await button("元に戻す").click();
  await expect(state).toContainText("サンプルからの変更なし");
  expect(await leaving()).toBe(true);
  await button("やり直す").click();
  const downloading = page.waitForEvent("download");
  await button("Project JSON を保存").click();
  await downloading;
  await expect(state).toContainText("書き出し要求後の変更なし");
  await expect(state).toContainText("最終書き出し要求");
  expect(await leaving()).toBe(true);
  await expect(page.getByTestId("project-status")).toContainText(
    "ダウンロードを開始",
  );
  await button("元に戻す").click();
  await expect(state).toContainText("未書き出しの変更あり");
  await button("やり直す").click();
  await expect(state).toContainText("書き出し要求後の変更なし");
});
test("unapplied selection input can be cancelled, applied or discarded without losing the selection", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
      page.getByRole("button", { name, exact: true }),
    list = page.getByRole("navigation", { name: "図形一覧" });
  await button("編集").click();
  const rectangle = list.getByRole("button", {
      name: "rectangle · 3",
      exact: true,
    }),
    ellipse = list.getByRole("button", { name: "ellipse · 4", exact: true });
  await rectangle.click();
  await page.getByLabel("x", { exact: true }).fill("200");
  await expect(page.getByTestId("save-state")).toContainText(
    "未適用の入力あり",
  );
  await ellipse.click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(rectangle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("200");
  await ellipse.click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(ellipse).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("img", { name: "プロセス画面", exact: true })
      .locator("[data-object-id]")
      .first(),
  ).toHaveAttribute("transform", "translate(200 170)");
  await rectangle.click();
  await page.getByLabel("x", { exact: true }).fill("250");
  await ellipse.click();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await rectangle.click();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("200");
  await page.getByLabel("x", { exact: true }).fill("201");
  await page.getByLabel("x", { exact: true }).fill("200");
  await ellipse.click();
  await expect(prompt).toHaveCount(0);
});
test("invalid native and model input stops the pending operation and remains editable", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await page.getByLabel("width", { exact: true }).fill("0");
  await button("表示プレビュー").click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("0");
  await expect(button("元に戻す")).toBeDisabled();
  await page.getByLabel("width", { exact: true }).fill("260");
  await button("配管を追加").click();
  await page.getByLabel("頂点", { exact: true }).fill("0,0\n0,0");
  await button("表示プレビュー").click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(page.getByTestId("project-status")).toContainText(
    "線には異なる2点が必要",
  );
  await expect(page.getByLabel("頂点", { exact: true })).toHaveValue(
    "0,0\n0,0",
  );
  await expect(page.getByTestId("save-state")).toContainText(
    "未適用の入力あり",
  );
  await button("表示プレビュー").click();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(page.getByRole("group", { name: "編集履歴" })).toHaveCount(0);
});
test("multiple forms are resolved before preview, and Ctrl+S in an input exports its applied value", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await page.getByLabel("x", { exact: true }).fill("345");
  await page.getByLabel("画面名", { exact: true }).fill("変更した画面");
  await button("表示プレビュー").click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await expect(prompt).toContainText("2 件");
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "変更した画面", exact: true }),
  ).toBeVisible();
  await button("編集").click();
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  const x = page.getByLabel("x", { exact: true });
  await x.fill("456");
  await x.press("Control+s");
  await expect(prompt).toBeVisible();
  const downloading = page.waitForEvent("download");
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  const saved = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(saved.screens[0].name).toBe("変更した画面");
  expect(saved.screens[0].objects[0].x).toBe(456);
  expect(saved.manifest.projectRevision).toBe(4);
  await expect(page.getByTestId("save-state")).not.toContainText(
    "未適用の入力あり",
  );
});
test("replacement validates first, preserves changes on cancel and exports before explicit replacement", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await button("Rectangle を追加").click();
  const input = page.getByLabel("Project JSON を開く", { exact: true }),
    svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await input.setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await expect(page.getByTestId("project-status")).toContainText("読込エラー");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  const next = structuredClone(sample);
  next.manifest.name = "別の Project";
  const file = {
    name: "valid.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(next)),
  };
  await input.setInputFiles(file);
  const prompt = page.getByRole("dialog", { name: "Project を置き換えますか" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  await expect(button("元に戻す")).toBeEnabled();
  await input.setInputFiles(file);
  const downloading = page.waitForEvent("download");
  await prompt
    .getByRole("button", { name: "JSON を書き出す", exact: true })
    .click();
  const saved = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(saved.screens[0].objects).toHaveLength(4);
  await expect(prompt).toBeVisible();
  await prompt
    .getByRole("button", { name: "破棄して開く", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "別の Project", exact: true }),
  ).toBeVisible();
  await expect(svg.locator("[data-object-id]")).toHaveCount(3);
  await expect(button("元に戻す")).toBeDisabled();
  await expect(page.getByTestId("save-state")).toContainText(
    "読込後の変更なし",
  );
});
test("a failed export never marks the current project as written out", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await button("Rectangle を追加").click();
  await page.evaluate(() => {
    HTMLAnchorElement.prototype.click = function () {
      throw new Error("download blocked");
    };
  });
  await button("Project JSON を保存").click();
  await expect(page.getByTestId("project-status")).toContainText(
    "書き出しエラー",
  );
  await expect(page.getByTestId("save-state")).toContainText(
    "未書き出しの変更あり",
  );
  await expect(page.getByTestId("save-state")).not.toContainText(
    "最終書き出し要求",
  );
});
test("resize handles resolve drafts before computing geometry from a stale placement", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await page.getByLabel("x", { exact: true }).fill("200");
  const handle = page.locator('[data-resize-handle="se"]');
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 20,
    box.y + box.height / 2 + 20,
  );
  await page.mouse.up();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await expect(prompt).toBeVisible();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("200");
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("260");
  await expect(page.getByTestId("save-state")).not.toContainText(
    "未適用の入力あり",
  );
  await button("元に戻す").click();
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("100");
  await expect(button("元に戻す")).toBeDisabled();
});

test("invalid model input preserves every dirty form before applying any command", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await button("配管を追加").click();
  await page.getByLabel("画面名", { exact: true }).fill("未適用の画面");
  await page.getByLabel("頂点", { exact: true }).fill("0,0\n0,0");
  await button("表示プレビュー").click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await expect(prompt).toContainText("2 件");
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(page.getByTestId("project-status")).toContainText(
    "線には異なる2点が必要",
  );
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "未適用の画面",
  );
  await expect(page.getByLabel("頂点", { exact: true })).toHaveValue(
    "0,0\n0,0",
  );
  await expect(
    page.getByRole("img", { name: "プロセス画面", exact: true }),
  ).toBeVisible();
  await button("Project JSON を保存").click();
  const downloading = page.waitForEvent("download");
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  const saved = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(saved.screens[0].name).toBe("プロセス画面");
  expect(saved.manifest.projectRevision).toBe(2);
  await button("元に戻す").click();
  await expect(button("元に戻す")).toBeDisabled();
});
