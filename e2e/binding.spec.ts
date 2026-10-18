import { selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/tag-binding.project.json" with { type: "json" };

test("assigns a read-only tag, shows disconnected in editor and preview, and preserves it through history and JSON", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  const input = page.getByLabel("表示タグ（外部名）", { exact: true });
  const name = "PLC01.Fast.Tank01.Level";
  await input.fill(name);
  await button("変更を適用").click();
  const tag = page.locator("text[data-tag-name]");
  await expect(tag).toHaveAttribute("data-tag-name", name);
  await expect(tag).toHaveAttribute("data-tag-state", "disconnected");
  await expect(tag).toContainText("-- · 未接続");
  await expect(tag).not.toContainText("BANTO / SCADA");
  await button("元に戻す").click();
  await expect(tag).toHaveCount(0);
  await expect(input).toHaveValue("");
  await button("やり直す").click();
  await expect(input).toHaveValue(name);
  await button("選択図形を複製").click();
  await expect(tag).toHaveCount(2);
  const downloading = page.waitForEvent("download");
  await button("Project JSON を保存").click();
  const saved = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(saved.manifest.schemaVersion).toBe("0.3.0");
  expect(saved.manifest.minRuntimeVersion).toBe("0.3.0");
  expect(
    saved.screens[0].objects
      .filter((o: any) => o.shape.binding)
      .map((o: any) => o.shape.binding),
  ).toEqual([{ externalName: name }, { externalName: name }]);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "bound.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await button("表示プレビュー").click();
  await expect(tag).toHaveCount(2);
  await expect(tag.first()).toContainText("-- · 未接続");
  await expect(
    page.getByLabel("表示タグ（外部名）", { exact: true }),
  ).toHaveCount(0);
  await button("編集").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  await input.fill("");
  await button("変更を適用").click();
  await expect(tag).toHaveCount(1);
  await expect(
    page.getByRole("img", { name: "プロセス画面", exact: true }),
  ).toContainText("BANTO / SCADA — Sample");
});

test("invalid assignment retains the input and selection, and invalid imported bindings preserve the project", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  const input = page.getByLabel("表示タグ（外部名）", { exact: true });
  await input.fill("   ");
  await button("表示プレビュー").click();
  await page
    .getByRole("dialog", { name: "未適用の入力があります" })
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(page.getByTestId("project-status")).toContainText("編集エラー");
  await expect(input).toHaveValue("   ");
  await expect(button("元に戻す")).toBeDisabled();
  const invalid = structuredClone(sample);
  (invalid.screens[0].objects[2].shape as any).binding = { tagId: 12 };
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "bad-binding.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(page.getByTestId("project-status")).toContainText("読込エラー");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(input).toHaveValue("   ");
  await input.fill("PLC01.計測.槽1.温度");
  await button("変更を適用").click();
  await expect(page.locator("text[data-tag-name]")).toHaveAttribute(
    "data-tag-name",
    "PLC01.計測.槽1.温度",
  );
});

test("the standalone binding sample loads without a Hub and keeps static shapes visible", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "sample.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect(
    page
      .getByRole("img", { name: "タグ表示（Hub 未接続）", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(3);
  await expect(page.locator("text[data-tag-name]")).toContainText(
    "-- · 未接続",
  );
  await expect(
    page.getByRole("button", { name: "Hub 接続", exact: true }),
  ).toHaveCount(0);
});
