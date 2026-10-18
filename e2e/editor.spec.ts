import { selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("edit, drag in design coordinates, save and reproduce in preview", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "Rectangle を追加" }).click();
  const svg = page.getByRole("img", { name: "プロセス画面" });
  await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  await page.getByLabel("x", { exact: true }).fill("230.5");
  await page.getByLabel("y", { exact: true }).fill("400");
  await page.getByLabel("width", { exact: true }).fill("180");
  await page.getByLabel("height", { exact: true }).fill("70");
  await page.getByLabel("色", { exact: true }).fill("#ff9900");
  await page.getByRole("button", { name: "変更を適用" }).click();
  const added = svg.locator("[data-object-id]").last();
  await expect(added).toHaveAttribute("transform", "translate(230.5 400)");
  await expect(added.locator("rect").first()).toHaveAttribute("width", "180");
  await added.scrollIntoViewIfNeeded();
  const box = await added.boundingBox();
  const canvas = await svg.boundingBox();
  if (!box || !canvas) throw Error("missing SVG geometry");
  const scale = canvas.width / 960;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + scale * 40,
    box.y + box.height / 2 - scale * 20,
    { steps: 5 },
  );
  await page.mouse.up();
  const x = Number(await page.getByLabel("x", { exact: true }).inputValue());
  const y = Number(await page.getByLabel("y", { exact: true }).inputValue());
  expect(x).toBeCloseTo(270.5, 0);
  expect(y).toBeCloseTo(380, 0);
  const transform = await added.getAttribute("transform");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Project JSON を保存" }).click();
  const download = await downloading;
  const json = await readFile((await download.path())!, "utf8");
  const saved = JSON.parse(json);
  expect(saved.screens[0].objects.at(-1)).toMatchObject({
    x,
    y,
    width: 180,
    height: 70,
    fill: "#ff9900",
  });
  expect(saved.manifest.projectRevision).toBe(8);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Rectangle を追加" }),
  ).toHaveCount(0);
  await expect(added).toHaveAttribute("transform", transform!);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "edited.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(svg.locator("[data-object-id]").last()).toHaveAttribute(
    "transform",
    transform!,
  );
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("button", { name: "rectangle · 6", exact: true })
    .click();
  await page.getByRole("button", { name: "選択図形を削除" }).click();
  await expect(svg.locator("[data-object-id]")).toHaveCount(3);
});
