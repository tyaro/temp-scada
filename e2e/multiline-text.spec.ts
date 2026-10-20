import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/multiline-text.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const note = sample.screens[0].objects[4];
const clipped = sample.screens[0].objects[6];
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const box = (page: Page, id = note.id) =>
  page.locator(`.sheet > svg [data-object-id="${id}"] svg[data-text-layout]`);
async function start(page: Page, project: any = sample) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "multiline.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  await page.locator(`button[data-layer-id="${note.id}"]`).click();
  await expect(box(page)).not.toHaveAttribute("data-text-layout", "pending");
}
async function saved(page: Page) {
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}
for (const theme of ["light", "dark"])
  test(`explicit blank lines, prefix ellipsis and ink bounds in ${theme}`, async ({
    page,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    await expect(box(page)).toHaveAttribute("data-text-multiline", "true");
    await expect(box(page)).toHaveAttribute("data-text-layout", "full");
    expect(
      await box(page).locator("[data-text-content]").allTextContents(),
    ).toEqual(note.shape.text!.split("\n"));
    await expect(box(page)).toHaveAttribute("aria-label", note.shape.text!);
    const positions = await box(page)
      .locator("[data-text-content]")
      .evaluateAll((els) =>
        els.map((el) => {
          const b = (el as SVGGraphicsElement).getBBox();
          return {
            y: Number(el.getAttribute("y")),
            x: b.x,
            top: b.y,
            right: b.x + b.width,
            bottom: b.y + b.height,
            text: el.textContent,
          };
        }),
      );
    for (let i = 0; i < positions.length; i++) {
      if (i)
        expect(positions[i].y - positions[i - 1].y).toBeCloseTo(18 * 1.2, 5);
      if (positions[i].text) {
        expect(positions[i].x).toBeGreaterThanOrEqual(1.99);
        expect(positions[i].right).toBeLessThanOrEqual(note.width);
        expect(positions[i].top).toBeGreaterThanOrEqual(0);
        expect(positions[i].bottom).toBeLessThanOrEqual(note.height);
      }
    }
    await expect(box(page, clipped.id)).toHaveAttribute(
      "data-text-layout",
      "ellipsis",
    );
    const lines = await box(page, clipped.id)
      .locator("[data-text-content]")
      .allTextContents();
    expect(lines.length).toBeLessThan(clipped.shape.text!.split("\n").length);
    expect(lines.slice(0, -1)).toEqual(
      clipped.shape.text!.split("\n").slice(0, lines.length - 1),
    );
    expect(lines.at(-1)).toBe(
      clipped.shape.text!.split("\n")[lines.length - 1] + "…",
    );
    await button(page, "表示プレビュー").click();
    await expect(box(page)).toHaveAttribute("data-text-layout", "full");
    expect((await saved(page)).screens).toEqual(sample.screens);
  });
test("Enter edits the memo, IME protects submission and Ctrl+Enter applies one undo", async ({
  page,
}) => {
  await start(page);
  const input = page.getByLabel("テキスト", { exact: true });
  await input.fill("一行目");
  await input.press("End");
  await input.press("Enter");
  await page.keyboard.insertText("二行目");
  await expect(input).toHaveValue("一行目\n二行目");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    ctrlKey: true,
    isComposing: true,
  });
  await expect(button(page, "元に戻す")).toBeDisabled();
  await input.dispatchEvent("compositionend");
  await input.press("Control+Enter");
  expect(
    await box(page).locator("[data-text-content]").allTextContents(),
  ).toEqual(["一行目", "二行目"]);
  await button(page, "元に戻す").click();
  await expect(input).toHaveValue(note.shape.text!);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await button(page, "やり直す").click();
  await expect(input).toHaveValue("一行目\n二行目");
});
test("native pasted separators normalize without mutating the staged memo", async ({
  page,
}) => {
  await start(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() =>
    navigator.clipboard.writeText("first\r\n\r\nsecond\u2028third\u2029last"),
  );
  const input = page.getByLabel("テキスト", { exact: true });
  await input.focus();
  await input.press("Control+a");
  await input.press("Control+v");
  await expect(input).toHaveValue(/first/);
  await expect(button(page, "元に戻す")).toBeDisabled();
  await input.press("Control+Enter");
  await expect(input).toHaveValue("first\n\nsecond\nthird\nlast");
  expect((await saved(page)).screens[0].objects[4].shape.text).toBe(
    "first\n\nsecond\nthird\nlast",
  );
});
test("too-small frames expose the full memo with an overflow warning", async ({
  page,
}) => {
  const project = structuredClone(sample);
  project.screens[0].objects[4].height = 1;
  await start(page, project);
  await expect(box(page)).toHaveAttribute("data-text-layout", "overflow");
  await expect(box(page).locator("[data-text-content]")).toHaveCount(0);
  await expect(box(page)).toHaveAttribute(
    "aria-label",
    `表示枠に収まりません · ${note.shape.text}`,
  );
  await expect(box(page).locator("path")).toHaveCount(2);
});
test("font completion and failure remeasure multiline ink without changing the project", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() => {
    const original = SVGGraphicsElement.prototype.getBBox;
    (window as any).__textScale = 10;
    SVGGraphicsElement.prototype.getBBox = function (...args) {
      const b = original.apply(this, args);
      return this.tagName === "text"
        ? new DOMRect(b.x, b.y, b.width * (window as any).__textScale, b.height)
        : b;
    };
    document.fonts.dispatchEvent(new Event("loadingdone"));
  });
  await expect(box(page)).toHaveAttribute("data-text-layout", "ellipsis");
  await page.evaluate(() => {
    (window as any).__textScale = 1;
    document.fonts.dispatchEvent(new Event("loadingerror"));
  });
  await expect(box(page)).toHaveAttribute("data-text-layout", "full");
  expect((await saved(page)).screens).toEqual(sample.screens);
});

test("direct tag display keeps one line and returns to the saved multiline memo", async ({
  page,
}) => {
  await start(page);
  const tag = page.getByLabel("表示タグ（外部名）", { exact: true });
  await tag.fill("PLC01.Fast.Value");
  await button(page, "変更を適用").click();
  await expect(box(page)).not.toHaveAttribute("data-text-multiline", "true");
  await expect(box(page)).toHaveAttribute("data-tag-state", "disconnected");
  expect((await saved(page)).screens[0].objects[4].shape.text).toBe(
    note.shape.text,
  );
  await tag.fill("");
  await button(page, "変更を適用").click();
  await expect(box(page)).toHaveAttribute("data-text-multiline", "true");
  expect(
    await box(page).locator("[data-text-content]").allTextContents(),
  ).toEqual(note.shape.text!.split("\n"));
});

test("metadata and read slots stay single-line while preserving a static multiline memo", async ({
  page,
}) => {
  const { default: fixture } = await import(
    "../examples/equipment-property.project.json",
    { with: { type: "json" } }
  );
  const project: any = structuredClone(fixture);
  for (const object of project.symbols[0].objects)
    if (object.shape.type === "text")
      object.shape.text = "保存したメモ\n二行目";
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "metadata.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator(".sheet > svg [data-text-multiline]")).toHaveCount(
    0,
  );
  await expect(
    page.locator(".sheet > svg [data-equipment-property]").first(),
  ).toBeVisible();
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  const object = project.symbols[0].objects.find(
    (o: any) => o.shape.equipmentProperty,
  );
  await page.locator(`button[data-layer-id="${object.id}"]`).click();
  const source = page.getByRole("combobox", { name: "表示元", exact: true });
  await source.selectOption("");
  await button(page, "変更を適用").click();
  await expect(box(page, object.id)).toHaveAttribute(
    "data-text-multiline",
    "true",
  );
  await expect(page.getByLabel("テキスト", { exact: true })).toHaveValue(
    "保存したメモ\n二行目",
  );
  await button(page, "元に戻す").click();
  await expect(box(page, object.id)).not.toHaveAttribute(
    "data-text-multiline",
    "true",
  );
});

for (const wrap of ["none", "word"] as const)
  test(`shared Symbol, minimap, embedded View and popup use the same multiline renderer (${wrap})`, async ({
    page,
  }) => {
    const project: any = structuredClone(sample);
    const memo: any = structuredClone(note);
    if (wrap === "word") {
      memo.shape.style.wrap = "word";
      memo.shape.text =
        "原水ポンプ P-101\n\nConfirm the water supply pressure and pump status before starting the circulation operation. 原水供給圧力を確認してください。";
    }
    const symbolId = "019a3200-0000-7000-8000-000000000100";
    project.symbols = [
      {
        id: symbolId,
        name: "運転メモ",
        width: 320,
        height: 230,
        folders: [],
        objects: [
          {
            ...structuredClone(memo),
            id: "019a3200-0000-7000-8000-000000000201",
            x: 0,
            y: 0,
          },
        ],
      },
    ];
    project.screens[0].objects[4] = {
      ...structuredClone(memo),
      shape: { type: "symbol", symbolId, colorMode: "definition" },
    };
    const sourceId = project.screens[0].id;
    project.screens.unshift({
      id: "019a3200-0000-7000-8000-000000000101",
      name: "埋込先",
      width: 960,
      height: 540,
      background: "#ffffff",
      folders: [],
      groups: [],
      objects: [
        {
          id: "019a3200-0000-7000-8000-000000000102",
          order: 0,
          x: 0,
          y: 0,
          width: 960,
          height: 540,
          rotation: 0,
          shape: { type: "screenView", screenId: sourceId, fit: "contain" },
        },
      ],
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await button(page, "編集").click();
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "reuse.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    const embedded = page.locator(
      `.sheet > svg [data-source-object-id="${note.id}"] [data-text-multiline]`,
    );
    await expect(embedded).toHaveAttribute("data-text-layout", "full");
    await expect(embedded).toHaveAttribute("data-text-wrap", wrap);
    await expect(
      page.locator('[aria-label="ミニマップ"] [data-text-multiline]').first(),
    ).toBeAttached();
    await button(page, "表示プレビュー").click();
    await button(page, "画面を小窓で表示確認").click();
    const dialog = page.getByRole("dialog", {
      name: "画面を小窓で表示確認",
      exact: true,
    });
    await dialog.locator(`input[value="${sourceId}"]`).check();
    await dialog
      .getByRole("button", { name: "小窓を表示", exact: true })
      .click();
    await expect(
      page.locator(
        `[data-preview-popup="${sourceId}"] [data-projected-object-id="${note.id}"] [data-text-multiline]`,
      ),
    ).toHaveAttribute("data-text-layout", "full");
    await expect(
      page.locator(
        `[data-preview-popup="${sourceId}"] [data-projected-object-id="${note.id}"] [data-text-multiline]`,
      ),
    ).toHaveAttribute("data-text-wrap", wrap);
  });

test("multiline clipboard and file round trips keep blank rows with one undo per paste", async ({
  page,
}) => {
  await start(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const row = page.locator(`button[data-layer-id="${note.id}"]`);
  await row.focus();
  await page.keyboard.press("Control+c");
  await expect(
    page.getByRole("status").filter({ hasText: "コピーしました" }).first(),
  ).toBeVisible();
  await page.keyboard.press("Control+v");
  const all = page.locator(".sheet > svg [data-object-id]");
  await expect(all).toHaveCount(sample.screens[0].objects.length + 1);
  const copied = await saved(page);
  expect(copied.screens[0].objects.at(-1).shape.text).toBe(note.shape.text);
  await button(page, "元に戻す").click();
  await expect(all).toHaveCount(sample.screens[0].objects.length);
  await row.click();
  await page.getByLabel("テキスト", { exact: true }).fill("未適用\nメモ");
  await page.locator(`button[data-layer-id="${clipped.id}"]`).click();
  const dialog = page.getByRole("dialog", {
    name: "未適用の入力があります",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByLabel("テキスト", { exact: true })).toHaveValue(
    "未適用\nメモ",
  );
  await page.getByLabel("テキスト", { exact: true }).press("Control+Enter");
  const project = await saved(page);
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "roundtrip.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(box(page)).toHaveAttribute("data-text-layout", "full");
  expect(
    await box(page).locator("[data-text-content]").allTextContents(),
  ).toEqual(["未適用", "メモ"]);
});

test("hidden multiline Symbol thumbnails recover when the category becomes visible", async ({
  page,
}) => {
  const project: any = structuredClone(sample);
  project.symbols = [
    {
      id: "019a3200-0000-7000-8000-000000000200",
      name: "メモ定義",
      width: 320,
      height: 230,
      folders: [],
      objects: [
        {
          ...structuredClone(note),
          id: "019a3200-0000-7000-8000-000000000201",
          x: 0,
          y: 0,
        },
      ],
    },
  ];
  await page.goto("/");
  await page.evaluate(() => {
    const original = SVGGraphicsElement.prototype.getBBox;
    SVGGraphicsElement.prototype.getBBox = function (...args) {
      if (this.closest("[hidden]"))
        throw new Error("Hidden SVG measurement unavailable");
      return original.apply(this, args);
    };
  });
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "hidden.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await button(page, "編集").click();
  await selectPanel(page, "部品");
  const category = page.locator('button[aria-controls="palette-symbols"]');
  if ((await category.getAttribute("aria-expanded")) === "true")
    await category.click();
  const thumbnail = page
    .getByRole("region", { name: "部品パレット" })
    .locator("#palette-symbols [data-text-multiline]");
  await expect(thumbnail).toHaveCount(1);
  await category.click();
  await expect(thumbnail).toHaveAttribute("data-text-layout", "full");
  expect(
    await thumbnail.locator("[data-text-content]").allTextContents(),
  ).toEqual(note.shape.text!.split("\n"));
});

function wrapFixture() {
  const project: any = structuredClone(sample),
    text = project.screens[0].objects[4];
  text.width = 140;
  text.height = 260;
  text.shape.text =
    "  alpha beta gamma delta epsilon zeta\n\n原水ポンプの運転状況を確認してください。 👨‍👩‍👧‍👦 e\u0301";
  return project;
}
for (const theme of ["light", "dark"] as const)
  test(`word wrap keeps original text and reflows width with independent Undo in ${theme}`, async ({
    page,
  }) => {
    const project = wrapFixture();
    await start(page, project);
    await chooseTheme(page, theme);
    const wrap = page.getByRole("combobox", {
      name: "文字の折返し",
      exact: true,
    });
    await expect(wrap).toHaveValue("none");
    await wrap.selectOption("word");
    await expect(box(page)).toHaveAttribute("data-text-wrap", "none");
    await button(page, "変更を適用").click();
    await expect(box(page)).toHaveAttribute("data-text-wrap", "word");
    await expect(box(page)).toHaveAttribute("data-text-layout", "full");
    const count = Number(await box(page).getAttribute("data-text-line-count"));
    expect(count).toBeGreaterThan(3);
    const original = (await saved(page)).screens[0].objects[4];
    expect(original.shape.text).toBe(project.screens[0].objects[4].shape.text);
    expect(original.shape.style.wrap).toBe("word");
    const width = page.getByLabel("width", { exact: true });
    await width.fill("300");
    await width.press("Enter");
    await expect
      .poll(async () =>
        Number(await box(page).getAttribute("data-text-line-count")),
      )
      .toBeLessThan(count);
    await expect(wrap).toHaveValue("word");
    await button(page, "元に戻す").click();
    await expect(box(page)).toHaveAttribute(
      "data-text-line-count",
      String(count),
    );
    await button(page, "元に戻す").click();
    await expect(wrap).toHaveValue("none");
    expect((await saved(page)).screens).toEqual(project.screens);
  });
test("word wrap remains a static setting across direct-tag mode and native file/clipboard round trips", async ({
  page,
}) => {
  const project = wrapFixture();
  project.screens[0].objects[4].shape.style.wrap = "word";
  await start(page, project);
  const tag = page.getByLabel("表示タグ（外部名）", { exact: true });
  await tag.fill("PLC01.Fast.Value");
  await button(page, "変更を適用").click();
  await expect(box(page)).not.toHaveAttribute("data-text-multiline", "true");
  await expect(box(page)).toHaveAttribute("data-tag-state", "disconnected");
  let current = await saved(page);
  expect(current.screens[0].objects[4].shape.style.wrap).toBe("word");
  await tag.fill("");
  await button(page, "変更を適用").click();
  await expect(box(page)).toHaveAttribute("data-text-wrap", "word");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const row = page.locator(`button[data-layer-id="${note.id}"]`);
  await row.focus();
  await page.keyboard.press("Control+c");
  await expect(
    page.getByRole("status").filter({ hasText: "コピーしました" }).first(),
  ).toBeVisible();
  await page.keyboard.press("Control+v");
  current = await saved(page);
  expect(current.screens[0].objects.at(-1).shape).toEqual(
    current.screens[0].objects[4].shape,
  );
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "wrap.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(current)),
  });
  await selectPanel(page, "レイヤー");
  await row.click();
  await expect(
    page.getByRole("combobox", { name: "文字の折返し", exact: true }),
  ).toHaveValue("word");
  await expect(box(page)).toHaveAttribute("data-text-wrap", "word");
  expect((await saved(page)).screens[0].objects[4].shape.text).toBe(
    project.screens[0].objects[4].shape.text,
  );
});
test("word wrap handles a single paragraph, empty text and height overflow without rewriting its memo", async ({
  page,
}) => {
  const project = wrapFixture(),
    text = project.screens[0].objects[4];
  text.shape.text = "alpha beta gamma delta epsilon";
  text.shape.style.wrap = "word";
  await start(page, project);
  await expect(box(page)).toHaveAttribute("data-text-layout", "full");
  expect(
    Number(await box(page).getAttribute("data-text-line-count")),
  ).toBeGreaterThan(1);
  await page.getByLabel("height", { exact: true }).fill("23");
  await page.getByLabel("height", { exact: true }).press("Enter");
  await expect(box(page)).toHaveAttribute("data-text-layout", "ellipsis");
  await expect(box(page)).toHaveAttribute(
    "aria-label",
    new RegExp(text.shape.text),
  );
  expect(
    (await box(page).locator("[data-text-content]").allTextContents())
      .join("")
      .match(/…/g),
  ).toHaveLength(1);
  await page.getByLabel("テキスト", { exact: true }).fill("");
  await button(page, "変更を適用").click();
  await expect(box(page)).not.toHaveAttribute("data-text-multiline", "true");
  expect((await saved(page)).screens[0].objects[4].shape.text).toBe("");
});
