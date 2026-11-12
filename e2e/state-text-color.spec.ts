import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/state-text-color.project.json" with { type: "json" };
import { chooseTheme, selectPanel, fileCommand } from "./helpers/designer";
for (const theme of ["light", "dark"] as const)
  test(`state-color following applies, disables, undoes and clears with slot changes in ${theme}`, async ({
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
      name: "slotの状態の色に従う",
      exact: true,
    });
    const text = page.locator(
      `.sheet > svg [data-object-id="${object.id}"] [data-text-content]`,
    );
    await expect(
      colors.getByLabel("状態の色に従う", { exact: true }),
    ).toHaveValue("enabled");
    await expect(text).toHaveAttribute("fill", "#d97706");
    await colors.getByLabel("取得不能の文字色").fill("#2563eb");
    await expect(colors.getByLabel("取得不能の文字色")).toHaveValue("#2563eb");
    await colors
      .getByRole("button", { name: "状態の色に従う指定を適用", exact: true })
      .click();
    await expect(text).toHaveAttribute("fill", "#2563eb");
    await colors
      .getByLabel("状態の色に従う", { exact: true })
      .selectOption("disabled");
    await colors
      .getByRole("button", { name: "状態の色に従う指定を適用", exact: true })
      .click();
    await expect(text).toHaveAttribute("fill", object.fill!);
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(
      colors.getByLabel("状態の色に従う", { exact: true }),
    ).toHaveValue("enabled");
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
    // 離れたら確定: Two dirty forms must not partly apply when the first one removes bool eligibility.
    await form.getByLabel("表示元", { exact: true }).selectOption("current");
    await colors
      .getByLabel("状態の色に従う", { exact: true })
      .selectOption("disabled");
    await page.getByRole("button", { name: "画面へ戻る", exact: true }).click();
    await expect(
      page
        .getByRole("alert")
        .getByText(
          "読取slotの解除・numberへの変更と状態の色に従う指定は同時に適用できません。",
          { exact: false },
        ),
    ).toBeVisible();
    await expect(colors).toBeVisible();
    await expect(form.getByLabel("表示元", { exact: true })).toHaveValue(
      "current",
    );
    await expect(
      colors.getByLabel("状態の色に従う", { exact: true }),
    ).toHaveValue("disabled");
    await expect(text).toHaveAttribute("fill", "#2563eb");
    // Restoring drafts to their committed values permits saving the unchanged model.
    await form.getByLabel("表示元", { exact: true }).selectOption("running");
    await colors
      .getByLabel("状態の色に従う", { exact: true })
      .selectOption("enabled");
    const downloading = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    const saved = JSON.parse(
      await readFile((await (await downloading).path())!, "utf8"),
    );
    expect(saved.symbols[0].objects[5].shape.stateColors).toEqual({
      unknownColor: "#2563eb",
    });
    expect(saved.manifest.schemaVersion).toBe("0.37.0");
  });
