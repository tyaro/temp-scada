import { fileCommand, selectPanel } from "./helpers/designer";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });

async function addPipe(page: Page, vertices: string) {
  await selectPanel(page, "部品");
  await button(page, "配管を追加").click();
  await page.getByLabel("頂点", { exact: true }).fill(vertices);
  await page.getByLabel("線幅", { exact: true }).fill("2");
  await page.getByLabel("X", { exact: true }).fill("40");
  await page.getByLabel("Y", { exact: true }).fill("40");
  await button(page, "変更を適用").click();
}
const hopChoice = (page: Page) =>
  page.getByLabel("交差のまたぎ", { exact: true });
async function setLineHops(
  page: Page,
  label: "なし" | "弧でまたぐ" | "弧でまたぎ、下の線を切る",
) {
  await selectPanel(page, "プロジェクト");
  await hopChoice(page).selectOption({ label });
  await button(page, "画面設定を適用").click();
}
async function save(page: Page) {
  const pending = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}

test("draws a hop where pipes cross, optionally cutting the crossed pipe, and saves the style", async ({
  page,
}) => {
  // 弧・切る・なしの切替と保存往復を 1 本で確かめるので、並列の負荷でも収まる長さにする。
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await selectPanel(page, "プロジェクト");
  await fileCommand(page, "工程図サンプルを開く");
  const svg = page.getByRole("img", {
    name: "循環設備（静的サンプル）",
    exact: true,
  });
  await expect(svg).toBeVisible({ timeout: 30_000 });
  await button(page, "編集").click();

  // 既定はなし（サンプルにまたぎはない）。
  await selectPanel(page, "プロジェクト");
  await expect(hopChoice(page)).toHaveValue("");
  await expect(svg.locator("path[data-line-hop]")).toHaveCount(0);

  // 何も選んでいないうちに画面設定で弧にしてから、交わる配管を足す。
  await setLineHops(page, "弧でまたぐ");
  await addPipe(page, "0,40\n200,40");
  const crossedId = await svg
    .locator("[data-object-id]")
    .last()
    .getAttribute("data-object-id");
  await addPipe(page, "100,0\n100,80");
  const crossing = svg.locator("[data-object-id]").last();
  const crossingId = await crossing.getAttribute("data-object-id");
  const hop = svg.locator(`path[data-line-hop="${crossingId}"]`);
  const cut = svg.locator(`path[data-line-hop="${crossedId}"]`);
  await expect(hop).toHaveCount(1);
  // 縦の線（後に描く線）が world (140, 80) で横の線を上から見て右へまたぐ。
  // ローカル座標: 交差は (100, 40)、半径 4。
  const hopD = "M 100 0 L 100 36 A 4 4 0 0 1 100 44 L 100 80";
  await expect(hop).toHaveAttribute("d", hopD);
  // 弧でまたぐときは、またがれる線を切らない。
  await expect(cut).toHaveCount(0);

  // 下の線を切る形にすると、横の線を交差点（ローカル (100, 40)）の ±7 で切る。弧はそのまま。
  await button(page, "選択解除").click();
  await setLineHops(page, "弧でまたぎ、下の線を切る");
  await expect(cut).toHaveAttribute("d", "M 0 40 L 93 40 M 107 40 L 200 40");
  await expect(hop).toHaveAttribute("d", hopD);
  await selectPanel(page, "プロジェクト");
  await expect(hopChoice(page)).toHaveValue("cut");

  // 表示プレビューでも同じ。
  await button(page, "表示プレビュー").click();
  await expect(svg.locator(`path[data-line-hop="${crossingId}"]`)).toHaveCount(
    1,
  );
  await expect(svg.locator(`path[data-line-hop="${crossedId}"]`)).toHaveCount(
    1,
  );
  await button(page, "編集").click();

  // 保存往復: 形を文字列で保存し、開き直しても描く。
  const project = await save(page);
  expect(project.manifest.schemaVersion).toBe("0.37.0");
  expect(project.screens[0].lineHops).toBe("cut");
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "line-hop.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(hop).toHaveCount(1);
  await expect(cut).toHaveCount(1);

  // 弧に戻すと切らない。1 操作で戻せる。
  await setLineHops(page, "弧でまたぐ");
  await expect(cut).toHaveCount(0);
  await expect(hop).toHaveCount(1);
  await button(page, "元に戻す").click();
  await expect(cut).toHaveCount(1);
  await button(page, "やり直す").click();
  await expect(cut).toHaveCount(0);
  expect((await save(page)).screens[0].lineHops).toBe("arc");

  // なしにすると消え、1 操作で戻せる。保存に書かない。
  await setLineHops(page, "なし");
  await expect(svg.locator("path[data-line-hop]")).toHaveCount(0);
  await button(page, "元に戻す").click();
  await expect(hop).toHaveCount(1);
  await button(page, "やり直す").click();
  await expect(svg.locator("path[data-line-hop]")).toHaveCount(0);
  const off = await save(page);
  expect("lineHops" in off.screens[0]).toBe(false);
  expect(errors).toEqual([]);
});
