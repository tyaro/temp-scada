import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/bool-colors.project.json" with { type: "json" };
import { chooseTheme, selectPanel, fileCommand } from "./helpers/designer";
for (const theme of ["light", "dark"] as const)
  test(`bool text colors apply, disable, undo and clear with slot changes in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "colors.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await page.getByRole("button", { name: "定義を編集", exact: true }).click();
    await selectPanel(page, "レイヤー");
    const object = sample.symbols[0].objects[5];
    await page.locator(`button[data-layer-id="${object.id}"]`).click();
    const colors = page.getByRole("form", {
      name: "bool slotの状態別文字色",
      exact: true,
    });
    const text = page.locator(
      `.sheet > svg [data-object-id="${object.id}"] [data-text-content]`,
    );
    await expect(colors.getByLabel("状態別の文字色を使用")).toHaveValue(
      "enabled",
    );
    await expect(text).toHaveAttribute("fill", "#d97706");
    await colors.getByLabel("取得不能の文字色").fill("#2563eb");
    // Another operation must preserve the color draft.
    await page.getByRole("button", { name: "画面へ戻る", exact: true }).click();
    const prompt = page.getByRole("dialog", {
      name: "未適用の入力があります",
      exact: true,
    });
    await expect(prompt).toBeVisible();
    await prompt
      .getByRole("button", { name: "キャンセル", exact: true })
      .click();
    await expect(colors.getByLabel("取得不能の文字色")).toHaveValue("#2563eb");
    await colors
      .getByRole("button", { name: "状態別の文字色を適用", exact: true })
      .click();
    await expect(text).toHaveAttribute("fill", "#2563eb");
    await colors.getByLabel("状態別の文字色を使用").selectOption("disabled");
    await colors
      .getByRole("button", { name: "状態別の文字色を適用", exact: true })
      .click();
    await expect(text).toHaveAttribute("fill", object.fill!);
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(colors.getByLabel("状態別の文字色を使用")).toHaveValue(
      "enabled",
    );
    await expect(text).toHaveAttribute("fill", "#2563eb");
    const form = page.locator('form[data-editor-form="object"]');
    await form.getByLabel("表示元", { exact: true }).selectOption("current");
    await form.getByRole("button", { name: "変更を適用", exact: true }).click();
    await expect(colors).toHaveCount(0);
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(colors).toBeVisible();
    await expect(form.getByLabel("表示元", { exact: true })).toHaveValue(
      "running",
    );
    await expect(text).toHaveAttribute("fill", "#2563eb");
    // Two dirty forms must not partly apply when the first one removes bool eligibility.
    await form.getByLabel("表示元", { exact: true }).selectOption("current");
    await colors.getByLabel("状態別の文字色を使用").selectOption("disabled");
    await page.getByRole("button", { name: "画面へ戻る", exact: true }).click();
    await prompt
      .getByRole("button", { name: "適用して続行", exact: true })
      .click();
    await expect(
      page
        .getByRole("alert")
        .getByText(
          "読取slotの解除・numberへの変更と状態別の文字色は同時に適用できません。",
          { exact: false },
        ),
    ).toBeVisible();
    await expect(colors).toBeVisible();
    await expect(form.getByLabel("表示元", { exact: true })).toHaveValue(
      "current",
    );
    await expect(colors.getByLabel("状態別の文字色を使用")).toHaveValue(
      "disabled",
    );
    await expect(text).toHaveAttribute("fill", "#2563eb");
    // Restoring drafts to their committed values permits saving the unchanged model.
    await form.getByLabel("表示元", { exact: true }).selectOption("running");
    await colors.getByLabel("状態別の文字色を使用").selectOption("enabled");
    const downloading = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    const saved = JSON.parse(
      await readFile((await (await downloading).path())!, "utf8"),
    );
    expect(saved.symbols[0].objects[5].shape.boolColors).toEqual({
      ...object.shape.boolColors,
      unknownColor: "#2563eb",
    });
    expect(saved.manifest.schemaVersion).toBe("0.33.0");
  });
