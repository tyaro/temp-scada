import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/embedded-screen.project.json" with { type: "json" };
import { chooseTheme } from "./helpers/designer";
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
const opener = (p: Page) => button(p, "画面を小窓で表示確認");
const popup = (p: Page, id: string) =>
  p.locator(`[data-preview-popup="${id}"]`);
async function start(p: Page, project: object = sample) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await button(p, "編集").click();
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "popup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await button(p, "表示プレビュー").click();
  await expect(opener(p)).toBeVisible();
}
async function open(p: Page, id: string) {
  await opener(p).click();
  const dialog = p.getByRole("dialog", {
    name: "画面を小窓で表示確認",
    exact: true,
  });
  await dialog.locator(`input[value="${id}"]`).check();
  await dialog.getByRole("button", { name: "小窓を表示", exact: true }).click();
  await expect(popup(p, id).locator("[data-popup-move]")).toBeFocused();
}
async function frame(el: Locator) {
  return el.evaluate((el) => ({
    x: parseFloat((el as HTMLElement).style.left),
    y: parseFloat((el as HTMLElement).style.top),
    width: parseFloat((el as HTMLElement).style.width),
    height: parseFloat((el as HTMLElement).style.height),
  }));
}
for (const theme of ["light", "dark"])
  test(`nonmodal popup supports keyboard move resize close and preserves Project in ${theme}`, async ({
    page: p,
  }) => {
    await start(p);
    await chooseTheme(p, theme);
    const id = sample.screens[0].id;
    await open(p, id);
    const window = popup(p, id),
      title = window.locator("[data-popup-move]");
    await expect(window).toHaveAttribute("aria-modal", "false");
    await expect(window.locator("[data-screen-view]")).toHaveCount(2);
    await expect(
      window.locator("[data-object-id],[data-resize-handle]"),
    ).toHaveCount(0);
    const before = await frame(window);
    await title.press("ArrowRight");
    await title.press("Shift+ArrowDown");
    expect(await frame(window)).toMatchObject({
      x: before.x + 8,
      y: before.y + 32,
    });
    const resize = window.locator("[data-popup-resize]");
    await resize.focus();
    await resize.press("ArrowLeft");
    await resize.press("Shift+ArrowUp");
    expect(await frame(window)).toMatchObject({
      width: before.width - 8,
      height: before.height - 32,
    });
    await opener(p).focus();
    await p.keyboard.press("Escape");
    await expect(window).toBeVisible();
    await title.focus();
    await title.press("Escape");
    await expect(window).toHaveCount(0);
    await expect(opener(p)).toBeFocused();
    const wait = p.waitForEvent("download");
    await p.keyboard.press("Control+s");
    const data = JSON.parse(
      await readFile((await (await wait).path())!, "utf8"),
    );
    expect(data).toEqual(sample);
  });
test("duplicates preserve frame and front existing window, fifth source is disabled without evicting windows", async ({
  page: p,
}) => {
  const project = structuredClone(sample) as any;
  for (let i = 0; i < 3; i++)
    project.screens.push({
      id: `0199ff10-0000-7000-8000-${String(i).padStart(12, "0")}`,
      name: `追加画面${i}`,
      width: 100,
      height: 100,
      background: "#ffffff",
      folders: [],
      objects: [],
    });
  await start(p, project);
  for (const screen of project.screens.slice(0, 4)) await open(p, screen.id);
  const first = popup(p, project.screens[0].id),
    title = first.locator("[data-popup-move]");
  await title.focus();
  await title.press("ArrowRight");
  const before = await frame(first);
  await open(p, project.screens[0].id);
  expect(await frame(first)).toEqual(before);
  await expect(first).toHaveCSS("z-index", "4");
  await expect(p.locator("[data-preview-popup]")).toHaveCount(4);
  await opener(p).click();
  const dialog = p.getByRole("dialog", {
    name: "画面を小窓で表示確認",
    exact: true,
  });
  await expect(
    dialog.locator(`input[value="${project.screens[4].id}"]`),
  ).toBeDisabled();
  await expect(dialog).toContainText("小窓は4件まで");
  await p.keyboard.press("Escape");
  await expect(p.locator("[data-preview-popup]")).toHaveCount(4);
});
test("pointer movement and resizing cancel with Esc and lost capture; viewport shrink keeps windows reachable", async ({
  page: p,
}) => {
  await start(p);
  const id = sample.screens[1].id;
  await open(p, id);
  const window = popup(p, id),
    title = window.locator("[data-popup-move]"),
    before = await frame(window);
  let box = (await title.boundingBox())!;
  await p.mouse.move(box.x + 50, box.y + 15);
  await p.mouse.down();
  await p.mouse.move(box.x + 160, box.y + 80);
  expect((await frame(window)).x).toBeGreaterThan(before.x);
  await p.keyboard.press("Escape");
  await p.mouse.up();
  expect(await frame(window)).toEqual(before);
  await expect(window).toBeVisible();
  const resize = window.locator("[data-popup-resize]");
  box = (await resize.boundingBox())!;
  await p.mouse.move(box.x + 10, box.y + 10);
  await p.mouse.down();
  await p.mouse.move(box.x - 70, box.y - 60);
  await resize.dispatchEvent("pointercancel", { pointerId: 1 });
  await p.mouse.up();
  expect(await frame(window)).toEqual(before);
  await p.setViewportSize({ width: 720, height: 540 });
  const area = p.getByRole("group", { name: "小窓表示領域", exact: true });
  await expect
    .poll(async () => {
      const a = (await area.boundingBox())!,
        w = (await window.boundingBox())!;
      return (
        w.x >= a.x - 0.1 &&
        w.y >= a.y - 0.1 &&
        w.x + w.width <= a.x + a.width + 0.1 &&
        w.y + w.height <= a.y + a.height + 0.1
      );
    })
    .toBe(true);
  await expect(
    window.getByRole("button", { name: /小窓を閉じる/ }),
  ).toBeVisible();
});
test("Banto Modal consumes Escape before Popup and background stays usable", async ({
  page: p,
}) => {
  await start(p);
  const id = sample.screens[1].id;
  await open(p, id);
  await opener(p).click();
  const chooser = p.getByRole("dialog", {
    name: "画面を小窓で表示確認",
    exact: true,
  });
  await expect(chooser).toBeVisible();
  await p.keyboard.press("Escape");
  await expect(chooser).not.toBeVisible();
  await expect(popup(p, id)).toBeVisible();
  await p
    .getByRole("menubar")
    .getByRole("menuitem", { name: "ヘルプ", exact: true })
    .click();
  await p
    .getByRole("menuitem", { name: "操作ガイド・アプリ情報", exact: true })
    .click();
  const help = p.getByRole("dialog", {
    name: "操作ガイド・アプリ情報",
    exact: true,
  });
  await expect(help).toBeVisible();
  await p.keyboard.press("Escape");
  await expect(help).not.toBeVisible();
  await expect(popup(p, id)).toBeVisible();
  await p.locator(`[data-screen-tab="${id}"]`).click();
  await expect(p.locator("[data-preview-popup]")).toHaveCount(0);
});
test("mode switch and Project replacement close picker and windows permanently", async ({
  page: p,
}) => {
  await start(p);
  const id = sample.screens[1].id;
  await open(p, id);
  await button(p, "編集").click();
  await expect(p.locator("[data-preview-popup]")).toHaveCount(0);
  await button(p, "表示プレビュー").click();
  await expect(p.locator("[data-preview-popup]")).toHaveCount(0);
  await open(p, id);
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect(p.locator("[data-preview-popup]")).toHaveCount(0);
  await opener(p).click();
  await p.keyboard.press("Escape");
  await expect(p.locator("[data-preview-popup]")).toHaveCount(0);
});

test("nonmodal windows keep F1 and file shortcuts available; background close preserves other focus", async ({
  page: p,
}) => {
  await start(p);
  const first = sample.screens[0].id,
    second = sample.screens[1].id;
  await open(p, first);
  await open(p, second);
  const title = popup(p, second).locator("[data-popup-move]");
  await title.focus();
  await popup(p, first)
    .getByRole("button", { name: /小窓を閉じる/ })
    .evaluate((el: HTMLButtonElement) => el.click());
  await expect(title).toBeFocused();
  await p.keyboard.press("F1");
  await expect(
    p.getByRole("dialog", { name: "操作ガイド・アプリ情報", exact: true }),
  ).toBeVisible();
  await p.keyboard.press("Escape");
  await expect(popup(p, second)).toBeVisible();
  const chooser = p.waitForEvent("filechooser");
  await opener(p).focus();
  await p.keyboard.press("Control+o");
  await (
    await chooser
  ).setFiles({
    name: "shortcut.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect(p.locator("[data-preview-popup]")).toHaveCount(0);
});

test("large plain source remains editable but popup chooser refuses its expanded cost", async ({
  page: p,
}) => {
  const project = structuredClone(sample) as any;
  project.screens[0].objects = [];
  const source = project.screens[1],
    symbol = project.symbols[0];
  symbol.folders = [];
  symbol.objects = Array.from({ length: 100 }, (_, i) => ({
    id: `0199ff31-0000-7000-8000-${i.toString().padStart(12, "0")}`,
    order: i,
    x: 0,
    y: 0,
    width: 2,
    height: 2,
    rotation: 0,
    visible: false,
    shape: {
      type: "rectangle",
      paint: {
        fill: {
          enabled: true,
          paint: { type: "solid", color: "#000000", alpha: 1 },
        },
        stroke: null,
      },
    },
  }));
  source.folders = [];
  source.objects = Array.from({ length: 200 }, (_, i) => ({
    id: `0199ff32-0000-7000-8000-${i.toString().padStart(12, "0")}`,
    order: i,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    fill: "#000000",
    rotation: 0,
    visible: false,
    shape: { type: "symbol", symbolId: symbol.id, colorMode: "definition" },
  }));
  await start(p, project);
  await opener(p).click();
  const dialog = p.getByRole("dialog", {
    name: "画面を小窓で表示確認",
    exact: true,
  });
  await expect(dialog.locator(`input[value="${source.id}"]`)).toBeDisabled();
  await expect(dialog).toContainText("20,000件を超えます");
  await dialog.locator(`input[value="${project.screens[0].id}"]`).check();
  await dialog.getByRole("button", { name: "小窓を表示", exact: true }).click();
  await expect(p.locator("[data-preview-popup]")).toHaveCount(1);
});

test("fronting a back window preserves pointer capture and Modal cancels its active drag", async ({
  page: p,
}) => {
  await start(p);
  const first = sample.screens[0].id,
    second = sample.screens[1].id;
  await open(p, first);
  await open(p, second);
  const window = popup(p, first),
    title = window.locator("[data-popup-move]"),
    before = await frame(window),
    box = (await title.boundingBox())!;
  await p.mouse.move(box.x + 20, box.y + 12);
  await p.mouse.down();
  await p.mouse.move(box.x + 100, box.y + 35);
  expect((await frame(window)).x).toBeGreaterThan(before.x);
  await expect(window).toHaveCSS("z-index", "2");
  await p.keyboard.press("F1");
  const help = p.getByRole("dialog", {
    name: "操作ガイド・アプリ情報",
    exact: true,
  });
  await expect(help).toBeVisible();
  expect(await frame(window)).toEqual(before);
  await p.mouse.up();
  await p.keyboard.press("Escape");
  await expect(help).not.toBeVisible();
  await expect(window).toBeVisible();
});

test("Project replacement during pointer capture disposes old windows without later edits", async ({
  page: p,
}) => {
  await start(p);
  const id = sample.screens[1].id;
  await open(p, id);
  const title = popup(p, id).locator("[data-popup-move]"),
    box = (await title.boundingBox())!;
  await p.mouse.move(box.x + 60, box.y + 15);
  await p.mouse.down();
  await p.mouse.move(box.x + 160, box.y + 70);
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "during-drag.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await p.mouse.up();
  await expect(p.locator("[data-preview-popup]")).toHaveCount(0);
  await open(p, id);
  expect((await frame(popup(p, id))).x).toBe(24);
});
