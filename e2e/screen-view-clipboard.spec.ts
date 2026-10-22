import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/embedded-screen.project.json" with { type: "json" };
import minimal from "../examples/minimal.project.json" with { type: "json" };
import { selectPanel, fileCommand } from "./helpers/designer";
import { pngFixture } from "./helpers/images";
const host = sample.screens[0],
  source = sample.screens[1],
  view = host.objects[1];
const views = (p: Page) =>
  p.locator(".sheet > svg > [data-object-id] [data-screen-view]");
async function select(p: Page, both = false) {
  await selectPanel(p, "レイヤー");
  await p.locator(`button[data-layer-id="${view.id}"]`).click();
  if (both)
    await p
      .locator(`button[data-layer-id="${host.objects[2].id}"]`)
      .click({ modifiers: ["Shift"] });
}
async function start(p: Page, background = false) {
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await p.getByRole("button", { name: "編集", exact: true }).click();
  const project = structuredClone(sample);
  if (background) {
    project.screens[1].objects = [];
    project.symbols = [];
  }
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "view.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(views(p)).toHaveCount(2);
  let bytes: Buffer | undefined;
  if (background) {
    await p.locator(`[data-screen-tab="${source.id}"]`).click();
    bytes = await pngFixture(p, {
      width: 400,
      height: 200,
      rectangles: [
        { x: 0, y: 0, width: 200, height: 200, color: "#e75840" },
        { x: 200, y: 0, width: 200, height: 200, color: "#1e9f85" },
      ],
    });
    await p.getByLabel("背景画像を取り込む", { exact: true }).setInputFiles({
      name: "source.png",
      mimeType: "image/png",
      buffer: bytes,
    });
    const crop = p.getByRole("form", {
      name: "背景画像のトリミング",
      exact: true,
    });
    for (const [name, value] of [
      ["cropX", "25"],
      ["cropY", "25"],
      ["cropWidth", "50"],
      ["cropHeight", "50"],
    ])
      await crop.locator(`[name="${name}"]`).fill(value);
    await crop
      .getByRole("button", { name: "背景の切出しを適用", exact: true })
      .click();
    await p.locator(`[data-screen-tab="${host.id}"]`).click();
  }
  await select(p);
  return bytes;
}
async function menu(p: Page, name: string) {
  await p
    .getByRole("menubar")
    .getByRole("menuitem", { name: "編集", exact: true })
    .click();
  await p
    .getByRole("menu", { name: "編集", exact: true })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
async function copy(p: Page) {
  await p.keyboard.press("ControlOrMeta+c");
  await expect(p.getByTestId("project-status")).toContainText("コピーしました");
  await expect
    .poll(() =>
      p.evaluate(async () => {
        try {
          return JSON.parse(await navigator.clipboard.readText()).version;
        } catch {
          return null;
        }
      }),
    )
    .toBe(4);
  return p.evaluate(async () =>
    JSON.parse(await navigator.clipboard.readText()),
  );
}
async function save(p: Page) {
  const pending = p.waitForEvent("download");
  await fileCommand(p, "Project を保存");
  const bytes = await readFile((await (await pending).path())!);
  return p.evaluate(
    async (raw) => {
      const path = "/src/lib/project-package.ts",
        { readProjectFile } = await import(path);
      const c = await readProjectFile(new Blob([new Uint8Array(raw)]));
      const originals = await Promise.all(
        c.project.assets.map(async (a: any) =>
          Array.from(
            new Uint8Array(await c.store.blob(a.sha256).arrayBuffer()),
          ),
        ),
      );
      const project = c.project;
      c.store.dispose();
      return { project, originals };
    },
    [...bytes],
  );
}
test("native copy/paste reuses one live source for two wrappers and cuts only the selected wrapper", async ({
  page,
}) => {
  await start(page);
  await select(page, true);
  const clip = await copy(page);
  expect(clip.project.screens).toHaveLength(2);
  expect(clip.project.screens[0].objects).toHaveLength(2);
  await page.keyboard.press("ControlOrMeta+v");
  await expect(views(page)).toHaveCount(4);
  let project = (await save(page)).project;
  expect(project.screens).toHaveLength(2);
  expect(project.symbols).toHaveLength(sample.symbols.length);
  expect(
    project.screens[0].objects.slice(-2).map((o: any) => o.shape.screenId),
  ).toEqual([source.id, source.id]);
  await page.keyboard.press("Control+z");
  await expect(views(page)).toHaveCount(2);
  await select(page);
  await page.keyboard.press("ControlOrMeta+x");
  await expect(views(page)).toHaveCount(1);
  project = (await save(page)).project;
  expect(project.screens[1]).toEqual(source);
  await page.keyboard.press("Control+z");
  await expect(views(page)).toHaveCount(2);
});
test("background-only clipboard imports one source and original into another Project, preserving crop with one Undo", async ({
  page,
}) => {
  const bytes = (await start(page, true))!;
  await select(page, true);
  const clip = await copy(page);
  expect(clip.images).toHaveLength(1);
  expect(clip.project.assets).toHaveLength(1);
  expect(clip.project.screens[1].objects).toEqual([]);
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "target.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(minimal)),
  });
  const replace = page.getByRole("dialog", {
    name: "Project を置き換えますか",
    exact: true,
  });
  await expect(replace).toBeVisible();
  await replace
    .getByRole("button", { name: "破棄して開く", exact: true })
    .click();
  await menu(page, "貼り付け");
  await expect(views(page)).toHaveCount(2);
  const result = await save(page),
    project = result.project;
  expect(project.screens).toHaveLength(2);
  expect(project.assets).toHaveLength(1);
  expect(project.screens[1].id).not.toBe(source.id);
  expect(project.screens[1].backgroundImage.crop).toEqual({
    x: 0.25,
    y: 0.25,
    width: 0.5,
    height: 0.5,
  });
  expect(result.originals).toEqual([Array.from(bytes)]);
  await expect(page.locator(".sheet [data-background-crop]")).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect(views(page)).toHaveCount(0);
  const undone = (await save(page)).project;
  expect(undone.screens).toHaveLength(1);
  expect(undone.assets).toHaveLength(0);
  await page.keyboard.press("Control+y");
  await expect(views(page)).toHaveCount(2);
  expect((await save(page)).originals).toEqual([Array.from(bytes)]);
});
test("same-workspace paste onto its own source is rejected without changing references or history", async ({
  page,
}) => {
  await start(page);
  await copy(page);
  await page.locator(`[data-screen-tab="${source.id}"]`).click();
  const before = (await save(page)).project;
  await menu(page, "貼り付け");
  await expect(page.getByTestId("project-status")).toContainText("自分自身");
  expect((await save(page)).project).toEqual(before);
  await expect(views(page)).toHaveCount(0);
});
test("failed clipboard write keeps the cut View, source screen and history", async ({
  page,
}) => {
  await start(page, true);
  const before = (await save(page)).project;
  await select(page);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: () => Promise.reject(new Error("denied")) },
    }),
  );
  await menu(page, "切り取り");
  await expect(page.getByTestId("project-status")).toContainText("denied");
  expect((await save(page)).project).toEqual(before);
  await expect(views(page)).toHaveCount(2);
});
