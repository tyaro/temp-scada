import { fileCommand } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/minimal.project.json" with { type: "json" };
test("sample renders, downloads, reloads, and invalid import preserves current screen", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const svg = page.getByRole("img", { name: "プロセス画面" });
  await expect(svg).toBeVisible();
  await expect(svg.locator("[data-object-id]")).toHaveCount(3);
  await page.screenshot({ path: "/tmp/scada-sample.png", fullPage: true });
  const downloadPromise = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  const download = await downloadPromise;
  const downloaded = await readFile((await download.path())!, "utf8");
  expect(JSON.parse(downloaded)).toEqual(sample);
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "saved.json",
    mimeType: "application/json",
    buffer: Buffer.from(downloaded),
  });
  await expect(page.getByTestId("project-status")).toContainText(
    "Project を読み込みました",
  );
  const changed = structuredClone(sample);
  changed.manifest.name = "読込テスト";
  changed.screens[0].objects[2].shape = {
    ...changed.screens[0].objects[2].shape,
    type: "text",
    text: "<script>bad()</script>",
  };
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(changed)),
  });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "読込テスト",
  );
  await expect(svg.locator("text[data-text-content]")).toHaveText(
    "<script>bad()</script>",
  );
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"screens":[]}'),
  });
  await expect(page.getByTestId("project-status")).toContainText("読込エラー");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "読込テスト",
  );
  await expect(svg.locator("[data-object-id]")).toHaveCount(3);
  expect(errors).toEqual([]);
});
