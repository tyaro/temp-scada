import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/state-color.project.json" with { type: "json" };
import { chooseTheme, selectPanel, fileCommand } from "./helpers/designer";
for (const theme of ["light", "dark"] as const) {
  test(`state color source, detach, draft and protection in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "states.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await page.getByRole("button", { name: "定義を編集", exact: true }).click();
    await selectPanel(page, "レイヤー");
    const line = sample.symbols[0].objects[0],
      source = sample.symbols[0].objects[5];
    await page.locator(`button[data-layer-id="${line.id}"]`).click();
    const form = page.getByRole("form", {
      name: "状態表示の色に追従",
      exact: true,
    });
    const paint = page.locator(
      `.sheet > svg [data-object-id="${line.id}"] polyline:not([stroke="transparent"])`,
    );
    await expect(form.getByLabel("配色元Text", { exact: true })).toHaveValue(
      source.id,
    );
    await expect(paint).toHaveAttribute("stroke", "#d97706");
    await form.getByLabel("配色元Text", { exact: true }).selectOption("");
    await page.getByRole("button", { name: "画面へ戻る", exact: true }).click();
    await page
      .getByRole("dialog", { name: "未適用の入力があります", exact: true })
      .getByRole("button", { name: "キャンセル", exact: true })
      .click();
    await expect(form.getByLabel("配色元Text", { exact: true })).toHaveValue(
      "",
    );
    await form
      .getByRole("button", { name: "状態色の追従を適用", exact: true })
      .click();
    await expect(paint).toHaveAttribute("stroke", line.fill!);
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(paint).toHaveAttribute("stroke", "#d97706");
    await form
      .getByRole("button", { name: "配色元Textを選択", exact: true })
      .click();
    await expect(
      page.getByText("状態色の追従先 7件。", { exact: false }),
    ).toBeVisible();
    const colors = page.getByRole("form", {
      name: "bool slotの状態別文字色",
      exact: true,
    });
    await colors.getByLabel("状態別の文字色を使用").selectOption("disabled");
    await colors
      .getByRole("button", { name: "状態別の文字色を適用", exact: true })
      .click();
    await expect(
      page.getByRole("alert").getByText("配色元Text", { exact: false }),
    ).toBeVisible();
    await expect(colors.getByLabel("状態別の文字色を使用")).toHaveValue(
      "disabled",
    );
    await colors.getByLabel("状態別の文字色を使用").selectOption("enabled");
    await page
      .locator(`button[data-layer-id="${sample.symbols[0].objects[7].id}"]`)
      .click();
    const follow = page.getByRole("form", {
      name: "状態表示の色に追従",
      exact: true,
    });
    const shapePaint = page.getByRole("form", {
      name: "塗りと枠線",
      exact: true,
    });
    await shapePaint.getByLabel("塗り", { exact: true }).selectOption("false");
    await follow.getByLabel("配色元Text", { exact: true }).selectOption("");
    await page.getByRole("button", { name: "画面へ戻る", exact: true }).click();
    await page
      .getByRole("dialog", { name: "未適用の入力があります", exact: true })
      .getByRole("button", { name: "適用して続行", exact: true })
      .click();
    await expect(follow.getByLabel("配色元Text", { exact: true })).toHaveValue(
      "",
    );
    await expect(shapePaint.getByLabel("塗り", { exact: true })).toHaveValue(
      "false",
    );
    await expect(
      page
        .locator(
          `.sheet > svg [data-object-id="${sample.symbols[0].objects[7].id}"] rect`,
        )
        .first(),
    ).toHaveAttribute("fill", "#d97706");
    await shapePaint.getByLabel("塗り", { exact: true }).selectOption("true");
    await follow
      .getByLabel("配色元Text", { exact: true })
      .selectOption(source.id);
    const downloading = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    const saved = JSON.parse(
      await readFile((await (await downloading).path())!, "utf8"),
    );
    expect(saved.symbols[0].objects[0].shape.stateColor).toEqual({
      textId: source.id,
    });
    expect(saved.symbols[0].objects[7].shape.paint).toEqual(
      sample.symbols[0].objects[7].shape.paint,
    );
    expect(saved.manifest.schemaVersion).toBe("0.32.0");
  });
}
