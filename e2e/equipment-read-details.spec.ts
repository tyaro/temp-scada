import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
import { chooseTheme, fileCommand } from "./helpers/designer";

for (const theme of ["light", "dark"] as const) {
  test(`equipment details share screen windows and stay read only in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "details.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    const opener = page.getByRole("button", {
      name: "機器の読取詳細",
      exact: true,
    });
    const popup = (id: string) =>
      page.locator(`[data-preview-popup="${id}"][data-popup-kind="equipment"]`);
    async function open(id: string) {
      await opener.click();
      const picker = page.getByRole("dialog", {
        name: "機器の読取詳細を開く",
        exact: true,
      });
      await picker.locator(`input[value="${id}"]`).check();
      await picker
        .getByRole("button", { name: "小窓を表示", exact: true })
        .click();
      await expect(popup(id)).toBeVisible();
    }
    const [first, second] = sample.equipment;
    await open(first.id);
    const one = popup(first.id);
    await expect(one).toContainText(`${first.code} · ${first.name}`);
    await expect(one.locator("[data-equipment-slot]")).toHaveCount(
      first.bindings.length,
    );
    await expect(
      one.locator('[data-equipment-slot="running"]'),
    ).toHaveAttribute("data-slot-state", "unassigned");
    const move = one.locator("[data-popup-move]");
    const before = await one.boundingBox();
    await move.press("ArrowRight");
    await move.press("Shift+ArrowDown");
    const moved = await one.boundingBox();
    expect(moved!.x).toBe(before!.x + 8);
    expect(moved!.y).toBe(before!.y + 32);
    await open(second.id);
    await expect(one).toContainText(first.code);
    await open(first.id);
    await expect(page.locator('[data-popup-kind="equipment"]')).toHaveCount(2);
    expect(
      await one.evaluate((e) => Number((e as HTMLElement).style.zIndex)),
    ).toBeGreaterThan(
      await popup(second.id).evaluate((e) =>
        Number((e as HTMLElement).style.zIndex),
      ),
    );
    expect(await one.boundingBox()).toEqual(moved);
    // A screen shares the very same stack and can be brought in front of equipment windows.
    const screenOpener = page.getByRole("button", {
      name: "画面を小窓で表示確認",
      exact: true,
    });
    await screenOpener.click();
    const picker = page.getByRole("dialog", {
      name: "画面を小窓で表示確認",
      exact: true,
    });
    await picker.locator(`input[value="${sample.screens[0].id}"]`).check();
    await picker
      .getByRole("button", { name: "小窓を表示", exact: true })
      .click();
    const screen = page.locator('[data-popup-kind="screen"]');
    expect(
      await screen.evaluate((e) => Number((e as HTMLElement).style.zIndex)),
    ).toBeGreaterThan(
      await one.evaluate((e) => Number((e as HTMLElement).style.zIndex)),
    );
    await one.locator("[data-popup-move]").focus();
    await one.locator("[data-popup-move]").press("Escape");
    await expect(one).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(screen).toBeVisible();
    await open(first.id);
    const downloading = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    const saved = JSON.parse(
      await readFile((await (await downloading).path())!, "utf8"),
    );
    expect(saved).toEqual(sample);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await expect(page.locator("[data-preview-popup]")).toHaveCount(0);
    // Same-ID file replacement also starts a new transient window generation.
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await open(first.id);
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "same.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await expect(page.locator("[data-preview-popup]")).toHaveCount(0);
  });
}

test("equipment details page and keyboard-scroll more than twenty adopted roles", async ({
  page,
}) => {
  const project = structuredClone(sample);
  const equipment = project.equipment[0];
  const type = project.equipmentTypes.find(
    (item) => item.id === equipment.typeId,
  )!;
  const original = type.slots[0];
  type.slots = Array.from({ length: 24 }, (_, i) => ({
    ...original,
    name: `role${String(i).padStart(2, "0")}`,
  }));
  for (const item of project.equipment.filter(
    (item) => item.typeId === type.id,
  ))
    item.bindings = [];
  equipment.bindings = type.slots.map((slot) => ({
    slotName: slot.name,
    externalName: null,
  }));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "many.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await page
    .getByRole("button", { name: "機器の読取詳細", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "機器の読取詳細を開く",
    exact: true,
  });
  await picker.locator(`input[value="${equipment.id}"]`).check();
  await picker.getByRole("button", { name: "小窓を表示", exact: true }).click();
  const window = page.locator('[data-popup-kind="equipment"]');
  await expect(window.locator("[data-equipment-slot]")).toHaveCount(20);
  const region = window.getByRole("region", {
    name: "機器の読取一覧をスクロール",
    exact: true,
  });
  await region.focus();
  await region.press("PageDown");
  await expect
    .poll(() => region.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(0);
  await window.getByRole("button", { name: "次へ", exact: true }).click();
  await expect(window.locator("[data-equipment-slot]")).toHaveCount(4);
  await expect(window.locator('[data-equipment-slot="role20"]')).toBeVisible();
  await window.getByRole("button", { name: "前へ", exact: true }).click();
  await expect(window.locator("[data-equipment-slot]")).toHaveCount(20);
});
