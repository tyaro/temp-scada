import { selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/tag-binding.project.json" with { type: "json" };
function project() {
  const next = structuredClone(sample);
  next.screens[0].name = "原水監視";
  const second = structuredClone(next.screens[0]);
  second.id = "0199f000-0000-7000-8000-000000000010";
  second.name = "処理水監視";
  second.objects.forEach(
    (o, i) => (o.id = `0199f000-0000-7000-8000-00000000001${i + 1}`),
  );
  const extra = structuredClone(second.objects[2]);
  extra.id = "0199f000-0000-7000-8000-000000000014";
  extra.order = 6;
  extra.y = 120;
  (extra.shape as any).binding = { externalName: "PLC01.Fast.Pump01.Pressure" };
  (extra.shape as any).text = "吐出圧";
  second.objects.push(extra);
  next.screens.push(second);
  return next;
}

test("groups references across screens, searches without editing, navigates with draft protection and reflects history", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  const fixture = project();
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "references.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await button("編集").click();
  const summary = page
    .locator("summary")
    .filter({ hasText: "Project のタグ参照" });
  await expect(summary).toHaveText("Project のタグ参照 · 2 タグ / 3 配置");
  await summary.click();
  const panel = page.getByRole("region", {
    name: "Project のタグ参照",
    exact: true,
  });
  await expect(panel.locator("tbody tr")).toHaveCount(2);
  const level = panel.locator('[data-tag-reference="PLC01.Fast.Tank01.Level"]');
  await expect(level.getByRole("button")).toHaveCount(2);
  await panel.getByLabel("タグ参照を検索").fill("ＰＲＥＳＳＵＲＥ");
  await expect(panel.locator("tbody tr")).toHaveCount(1);
  await expect(panel).toContainText("PLC01.Fast.Pump01.Pressure");
  await panel.getByLabel("タグ参照を検索").fill("吐出圧");
  await expect(panel.locator("tbody tr")).toHaveCount(1);
  await panel.getByLabel("タグ参照を検索").fill("not-present");
  await expect(panel).toContainText("一致するタグ参照がありません");
  await selectPanel(page, "部品");
  await panel
    .getByRole("button", { name: "検索をクリア", exact: true })
    .click();
  await expect(page.getByTestId("save-state")).toContainText(
    "読込後の変更なし",
  );
  await page
    .getByRole("button", { name: "プロパティを隠す", exact: true })
    .click();
  await level
    .getByRole("button", { name: "処理水監視 の Text 5 を編集", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "処理水監視", exact: true }),
  ).toBeVisible();
  const input = page.getByLabel("表示タグ（外部名）", { exact: true });
  await expect(input).toBeFocused();
  await input.fill("PLC01.Fast.NewLevel");
  await panel
    .getByRole("button", { name: "原水監視 の Text 5 を編集", exact: true })
    .click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "処理水監視", exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("PLC01.Fast.NewLevel");
  await panel
    .getByRole("button", { name: "原水監視 の Text 5 を編集", exact: true })
    .click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "原水監視", exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("PLC01.Fast.Tank01.Level");
  await expect(summary).toHaveText("Project のタグ参照 · 3 タグ / 3 配置");
  await button("元に戻す").click();
  await expect(summary).toHaveText("Project のタグ参照 · 2 タグ / 3 配置");
  await button("やり直す").click();
  await expect(summary).toHaveText("Project のタグ参照 · 3 タグ / 3 配置");
  const downloading = page.waitForEvent("download");
  await button("Project JSON を保存").click();
  const saved = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(saved).not.toHaveProperty("references");
  expect(saved.screens[1].objects[2].shape.binding.externalName).toBe(
    "PLC01.Fast.NewLevel",
  );
});

test("the reference panel fits a small screen and resets search after importing another project", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const input = page.getByLabel("Project JSON を開く", { exact: true });
  const file = {
    name: "references.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project())),
  };
  await input.setInputFiles(file);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const summary = page
    .locator("summary")
    .filter({ hasText: "Project のタグ参照" });
  await summary.click();
  await page.getByLabel("タグ参照を検索").fill("missing");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await input.setInputFiles(file);
  await summary.click();
  await expect(page.getByLabel("タグ参照を検索")).toHaveValue("");
  await expect(
    page
      .getByRole("region", { name: "Project のタグ参照", exact: true })
      .locator("tbody tr"),
  ).toHaveCount(2);
});
