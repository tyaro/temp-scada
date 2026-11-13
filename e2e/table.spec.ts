import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import fixtures from "../examples/read-display-cases.json" with { type: "json" };
import {
  chooseTheme,
  fileCommand,
  mainCanvas,
  selectPanel,
} from "./helpers/designer";
import { openProject } from "./helpers/project-files";

const tableId = "0199f6aa-0000-7000-8000-000000000901";
function tableProject() {
  const project = structuredClone(sample) as any;
  project.screens[0].objects.push({
    id: tableId,
    order: 900,
    x: 560,
    y: 40,
    width: 300,
    height: 90,
    rotation: 0,
    fill: "#e5e7eb",
    shape: {
      type: "table",
      columns: [2, 1, 1],
      rows: [1, 1, 1],
      cells: [
        [
          { text: "工程", fill: "#334155" },
          { text: "開始", fill: "#334155" },
          { text: "完了", fill: "#334155" },
        ],
        [{ text: "搾汁" }, { text: "08:00", color: "#22c55e" }, { text: "" }],
        [{ text: "糖化" }, { text: "" }, { text: "" }],
      ],
      style: { fontSize: 14, fontWeight: "normal", align: "center" },
      border: { color: "#94a3b8", width: 1 },
      background: "#0f172a",
    },
  });
  return project;
}

async function open(page: Page) {
  await openProject(page, {
    name: "table.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(tableProject())),
  });
}

async function save(page: Page) {
  const downloading = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
}

for (const theme of ["light", "dark"] as const)
  test(`a table draws its cells, fills and grid in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await open(page);
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    const table = mainCanvas(page).locator(
      `[data-object-id="${tableId}"] [data-table]`,
    );
    await expect(table).toHaveAttribute("data-table-rows", "3");
    await expect(table).toHaveAttribute("data-table-columns", "3");
    // 列幅 2:1:1 で 300 を分ける。
    const second = table.locator('[data-table-cell="1:1"]');
    await expect(second).toHaveAttribute("x", "150");
    await expect(second).toHaveAttribute("y", "30");
    await expect(second).toHaveAttribute("width", "75");
    await expect(second.locator("[data-table-text]")).toHaveText("08:00");
    await expect(second.locator("[data-table-text]")).toHaveAttribute(
      "fill",
      "#22c55e",
    );
    await expect(
      table.locator('[data-table-cell="0:0"] [data-table-text]'),
    ).toHaveAttribute("fill", "#e5e7eb");
    await expect(table.locator('[data-table-cell="0:2"] rect')).toHaveAttribute(
      "fill",
      "#334155",
    );
    // 空のセルは文字を描かない。
    await expect(
      table.locator('[data-table-cell="1:2"] [data-table-text]'),
    ).toHaveCount(0);
    await expect(table.locator("[data-table-grid]")).toHaveAttribute(
      "d",
      "M150 0V90M225 0V90M0 30H300M0 60H300",
    );
    await expect(table.locator("[data-table-background]")).toHaveAttribute(
      "fill",
      "#0f172a",
    );
    await expect(page.locator(".error")).toHaveCount(0);
  });

test("the Inspector edits a table with tab-separated text and colors", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await open(page);
  await selectPanel(page, "レイヤー");
  await page.locator(`button[data-layer-id="${tableId}"]`).click();
  const form = page.locator('form[data-editor-form="object"]');
  const text = form.getByLabel("セルの文字", { exact: true });
  await expect(text).toHaveValue("工程\t開始\t完了\n搾汁\t08:00\t\n糖化\t\t");
  await expect(form.getByLabel("列幅の比", { exact: true })).toHaveValue(
    "2, 1, 1",
  );
  await expect(form.getByLabel("セルの塗り", { exact: true })).toHaveValue(
    "#334155\t#334155\t#334155",
  );

  // Tab はタブを入れる（フォーカスは移らない）。
  await text.fill("");
  await text.pressSequentially("A");
  await text.press("Tab");
  await text.pressSequentially("B");
  await expect(text).toBeFocused();
  await expect(text).toHaveValue("A\tB");
  await text.press("Enter");
  await text.pressSequentially("C");
  await form.getByLabel("列幅の比", { exact: true }).fill("");
  await form.getByLabel("セルの塗り", { exact: true }).fill("\t#ff0000");
  // 色の表は位置で対応するので、文字の表を組み替えたら文字色の表も空にする。
  await form.getByLabel("セルの文字色", { exact: true }).fill("");
  await form.getByLabel("表の罫線", { exact: true }).selectOption("none");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(form.getByLabel("表の罫線", { exact: true })).toHaveValue(
    "none",
  );
  const table = mainCanvas(page).locator(
    `[data-object-id="${tableId}"] [data-table]`,
  );
  await expect(table).toHaveAttribute("data-table-rows", "2");
  await expect(table).toHaveAttribute("data-table-columns", "2");
  await expect(table.locator("[data-table-grid]")).toHaveCount(0);

  // 表より大きい色の表は拒否し、保存済みの表は変わらない。
  await form
    .getByLabel("セルの塗り", { exact: true })
    .fill("#000000\t#000000\t#000000");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(
    page.getByText(/セルの塗りの列が表の列（2列）より多く/).first(),
  ).toBeVisible();
  await expect(table).toHaveAttribute("data-table-columns", "2");
  // 未適用の入力が残ると保存の前に確認が出るので、正しい値へ戻して適用する。
  await form.getByLabel("セルの塗り", { exact: true }).fill("\t#ff0000");
  await form.getByRole("button", { name: "変更を適用" }).click();

  const project = await save(page);
  const saved = project.screens[0].objects.find(
    (object: { id: string }) => object.id === tableId,
  );
  expect(saved.shape).toEqual({
    type: "table",
    columns: [1, 1],
    rows: [1, 1],
    cells: [
      [{ text: "A" }, { text: "B", fill: "#ff0000" }],
      [{ text: "C" }, { text: "" }],
    ],
    style: { fontSize: 14, fontWeight: "normal", align: "center" },
    background: "#0f172a",
  });
});

test("a table is added from the part palette and cannot be flipped", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  const palette = page.getByRole("region", {
    name: "部品パレット",
    exact: true,
  });
  await palette.getByRole("searchbox", { name: "部品を検索" }).fill("工程表");
  await palette.getByRole("button", { name: "表を追加", exact: true }).click();
  const project = await save(page);
  const placed = project.screens[0].objects.at(-1);
  expect(placed.shape.type).toBe("table");
  expect(
    placed.shape.cells.map((row: { text: string }[]) => row.length),
  ).toEqual([3, 3, 3]);
  // 追加した表は選択中のまま。文字を含むので反転できない。
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "編集", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "左右反転", exact: true }),
  ).toBeDisabled();
});

/** Same test-only read source as numeric-format.spec.ts. */
async function fixtureEntry(page: Page) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const mount =
      /if \("__TAURI_INTERNALS__" in window\) \{[\s\S]*?\} else \{\s*mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);\s*\}/;
    expect(original).toMatch(mount);
    const injected = `
      import { createSubscriber } from "/node_modules/.vite/deps/svelte_reactivity.js";
      const trackSource = createSubscriber(() => () => {});
      const h = window.__readHarness = {};
      const source = {subscribe(project, begin) {
        h.delivery = begin();
        return () => {};
      }};
      mount(App, {target: document.getElementById("app"), props: {get readSource() {trackSource(); return source;}}});
    `;
    await route.fulfill({ response, body: original.replace(mount, injected) });
  });
}

async function send(
  page: Page,
  sequence: number,
  name: "good" | "stale",
  numericValue?: number,
) {
  const update = structuredClone(
    fixtures.find((fixture) => fixture.name === name)!.update,
  ) as any;
  update.sequence = sequence;
  // カタログにないタグは未解決として届く（Text plan に全タグが要る）。
  update.text.readings["Demo.Missing"] = { state: "unresolved" };
  if (numericValue !== undefined) {
    update.text.readings["Demo.Number"].numericValue = numericValue;
    for (const row of update.slots.slots)
      if (row.externalName === "Demo.Number")
        row.reading.value = { type: "number", value: numericValue };
  }
  return page.evaluate(
    (update) => (window as any).__readHarness.delivery.receive(update),
    update,
  );
}

test("bound table cells show the reading with their format and missing readings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await fixtureEntry(page);
  await page.goto("/");
  const project = tableProject();
  const cells = project.screens[0].objects.at(-1).shape.cells;
  cells[1][1] = {
    text: "08:00",
    color: "#22c55e",
    binding: { externalName: "Demo.Number" },
    format: { decimals: 2, unit: "m3/h" },
  };
  cells[1][2] = { text: "", binding: { externalName: "Demo.Missing" } };
  await openProject(page, {
    name: "table-binding.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  const table = mainCanvas(page).locator(
    `[data-object-id="${tableId}"] [data-table]`,
  );
  const value = table.locator('[data-table-cell="1:1"]');
  const missing = table.locator('[data-table-cell="1:2"]');
  await expect(value).toHaveAttribute("data-table-cell-tag", "Demo.Number");
  await expect(missing).toHaveAttribute("data-table-cell-tag", "Demo.Missing");
  // 固定の文字のセルにはタグの属性を付けない。
  await expect(
    table.locator('[data-table-cell="1:0"][data-table-cell-tag]'),
  ).toHaveCount(0);

  expect(await send(page, 1, "good", 12.346)).toBe(true);
  await expect(value.locator("[data-table-text]")).toHaveText("12.35 m3/h");
  await expect(value).toHaveAttribute("data-table-cell-state", "good");
  // 文字色の規則は第1段のまま（セルの文字色）。
  await expect(value.locator("[data-table-text]")).toHaveAttribute(
    "fill",
    "#22c55e",
  );
  await expect(value.locator("title")).toHaveText("Demo.Number · Good");
  // 値のないタグは保存した文字に戻らず、欠測として出す。
  await expect(missing.locator("[data-table-text]")).toHaveText("-- · 未解決");
  await expect(missing).toHaveAttribute("data-table-cell-state", "unresolved");
  await expect(missing.locator("title")).toHaveText("Demo.Missing · 未解決");

  expect(await send(page, 2, "stale")).toBe(true);
  // 更新停止は単位を出さない（Text の数値表示と同じ）。
  await expect(value.locator("[data-table-text]")).toHaveText(
    "SIM · -- · 更新停止",
  );
  await expect(value).toHaveAttribute("data-table-cell-state", "stale");
  await expect(page.locator(".error")).toHaveCount(0);
});

test("the Inspector binds table cells to tags with a format", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await open(page);
  await selectPanel(page, "レイヤー");
  await page.locator(`button[data-layer-id="${tableId}"]`).click();
  const form = page.locator('form[data-editor-form="object"]');
  await expect(form.getByLabel("セルのタグ", { exact: true })).toHaveValue("");
  await form.getByLabel("セルのタグ", { exact: true }).fill("\n\tDemo.Number");
  // タグのないセルの書式は拒否する。
  await form.getByLabel("セルの書式", { exact: true }).fill("1;");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(page.getByText(/タグのないセル/).first()).toBeVisible();
  await form.getByLabel("セルの書式", { exact: true }).fill("\n\t1;℃");
  await form.getByRole("button", { name: "変更を適用" }).click();
  await expect(form.getByLabel("セルの書式", { exact: true })).toHaveValue(
    "\n\t1;℃",
  );
  const project = await save(page);
  const saved = project.screens[0].objects.find(
    (object: { id: string }) => object.id === tableId,
  );
  expect(saved.shape.cells[1][1]).toEqual({
    text: "08:00",
    color: "#22c55e",
    binding: { externalName: "Demo.Number" },
    format: { decimals: 1, unit: "℃" },
  });
});
