import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
const sample = JSON.parse(
  readFileSync("examples/geometric-groups.project.json", "utf8"),
);
import { fileCommand } from "./helpers/designer";

test("group Project, native clipboard v3, save and history retain membership", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "group.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const canvas = page.getByRole("img", { name: "プロセス画面", exact: true });
  await expect(canvas.locator("[data-object-id]")).toHaveCount(3);
  await canvas.click({ position: { x: 10, y: 10 } });
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  const payload = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  expect(payload.version).toBe(3);
  expect(payload.project.screens[0].groups[0].memberIds).toEqual(
    sample.screens[0].groups[0].memberIds,
  );
  await page.keyboard.press("Control+v");
  await expect(canvas.locator("[data-object-id]")).toHaveCount(6);
  const download = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const data = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(data.manifest.schemaVersion).toBe("0.30.0");
  expect(data.screens[0].groups).toHaveLength(2);
  const groups = data.screens[0].groups;
  expect(groups[0].id).not.toBe(groups[1].id);
  expect(
    groups[1].memberIds.every(
      (id: string) => !groups[0].memberIds.includes(id),
    ),
  ).toBe(true);
  await canvas.click({ position: { x: 10, y: 10 } });
  await page.keyboard.press("Control+z");
  await expect(canvas.locator("[data-object-id]")).toHaveCount(3);
  await page.keyboard.press("Control+y");
  await expect(canvas.locator("[data-object-id]")).toHaveCount(6);
});

test("invalid group import retains the current Project", async ({ page }) => {
  await page.goto("/");
  const invalid = structuredClone(sample);
  invalid.screens[0].groups[0].memberIds.reverse();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "invalid-group.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(page.getByTestId("project-status")).toContainText("グループ");
  const download = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const data = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(data.screens[0].groups).toEqual([]);
  expect(data.screens[0].objects).toHaveLength(3);
});
