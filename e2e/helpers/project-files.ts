import { expect, type Download, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

export type ProjectInput =
  string | { name: string; mimeType: string; buffer: Buffer };
/** Successful load only. Draft/error/late-response scenarios keep their explicit steps. */
export async function openProject(
  page: Page,
  file: ProjectInput,
): Promise<void> {
  const input = page.getByLabel("Project を開く", { exact: true });
  await input.setInputFiles(file);
  // The app clears/replaces the input only after reading. An old success message
  // by itself cannot prove that a second load of the same Project has finished.
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  await expect(page.getByTestId("project-status")).toHaveText(
    "Project を読み込みました。",
  );
  await expect(
    page.getByRole("dialog", { name: "未適用の入力があります", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Project を置き換えますか", exact: true }),
  ).toHaveCount(0);
}
export async function downloadProject(page: Page): Promise<Download> {
  const pending = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return pending;
}
export async function downloadBytes(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("Project download did not produce a local file");
  return readFile(path);
}
