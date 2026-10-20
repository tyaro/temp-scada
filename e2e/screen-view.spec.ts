import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/embedded-screen.project.json" with { type: "json" };
import { chooseTheme, selectPanel, fileCommand } from "./helpers/designer";
const host = sample.screens[0],
  source = sample.screens[1],
  view = host.objects[1];
const btn = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
const outer = (p: Page, id = view.id) =>
  p.locator(`.sheet > svg > [data-object-id="${id}"]`);
const projection = (p: Page, id = view.id) =>
  outer(p, id).locator("[data-screen-view]");
async function start(p: Page, project: object = sample) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await btn(p, "編集").click();
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "embedded.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(projection(p)).toBeVisible();
  await selectPanel(p, "レイヤー");
  await p.locator(`button[data-layer-id="${view.id}"]`).click();
}
async function save(p: Page) {
  const wait = p.waitForEvent("download");
  await p.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await wait).path())!, "utf8"));
}
async function number(p: Page, name: string, value: string) {
  const input = p.getByLabel(name, { exact: true });
  await input.fill(value);
  await input.press("Enter");
  await expect(input).toHaveValue(value);
}
async function editMenu(p: Page, name: string) {
  await p
    .getByRole("menubar")
    .getByRole("menuitem", { name: "編集", exact: true })
    .click();
  await p
    .getByRole("menu", { name: "編集", exact: true })
    .getByRole("menuitem", { name, exact: true })
    .click();
}
async function insertMenu(p: Page) {
  await p
    .getByRole("menubar")
    .getByRole("menuitem", { name: "挿入", exact: true })
    .click();
  await p
    .getByRole("menu", { name: "挿入", exact: true })
    .getByRole("menuitem", { name: "画面を埋め込む", exact: true })
    .click();
}
for (const theme of ["light", "dark"])
  test(`View shares source, edits outer geometry, saves and previews in ${theme}`, async ({
    page: p,
  }) => {
    await start(p);
    await chooseTheme(p, theme);
    await expect(p.getByLabel("参照する画面", { exact: true })).toHaveValue(
      source.id,
    );
    await expect(projection(p).locator("[data-symbol-id]")).toHaveCount(2);
    await expect(projection(p).locator("[data-object-id]")).toHaveCount(0);
    await expect(projection(p).locator("[data-source-object-id]")).toHaveCount(
      source.objects.length,
    );
    await number(p, "width", "760");
    await number(p, "回転角度", "25");
    await number(p, "不透明度（%）", "65");
    await expect(
      outer(p).locator(":scope > [data-object-rotation]"),
    ).toHaveAttribute("opacity", "0.65");
    await expect(projection(p)).toHaveAttribute("width", "760");
    await btn(p, "元に戻す").click();
    await expect(
      outer(p).locator(":scope > [data-object-rotation]"),
    ).not.toHaveAttribute("opacity");
    await btn(p, "やり直す").click();
    const result = await save(p);
    expect(result.screens[0].objects[1]).toMatchObject({
      width: 760,
      rotation: 25,
      opacity: 0.65,
      shape: { screenId: source.id, fit: "contain" },
    });
    expect(result.screens[0].objects[1].fill).toBeUndefined();
    await btn(p, "参照する画面を開く").click();
    await expect(p.locator(".sheet > svg")).toHaveAttribute(
      "viewBox",
      `0 0 ${source.width} ${source.height}`,
    );
    await p.locator(`button[data-layer-id="${source.objects[0].id}"]`).click();
    await number(p, "x", "75");
    await p.locator(`[data-screen-tab="${host.id}"]`).click();
    await expect(
      projection(p).locator(
        `[data-source-object-id="${source.objects[0].id}"]`,
      ),
    ).toHaveAttribute("transform", /^translate\(75/);
    await btn(p, "表示プレビュー").click();
    await expect(projection(p)).toBeVisible();
    await expect(p.locator(".sheet [data-resize-handle]")).toHaveCount(0);
  });
test("View clips source bounds independently of contain letterboxing and supports outer selection", async ({
  page: p,
}) => {
  const project = structuredClone(sample) as any;
  const src = project.screens[1];
  src.width = 100;
  src.height = 100;
  src.background = "#112233";
  src.objects = [
    {
      id: source.objects[0].id,
      order: 0,
      x: -50,
      y: 30,
      width: 200,
      height: 40,
      rotation: 0,
      shape: {
        type: "rectangle",
        paint: {
          fill: {
            enabled: true,
            paint: { type: "solid", color: "#ff0000", alpha: 1 },
          },
          stroke: null,
        },
      },
    },
  ];
  src.folders = [];
  project.screens[0].objects[1].width = 200;
  project.screens[0].objects[1].height = 100;
  await start(p, project);
  const pixels = await projection(p).evaluate(async (el) => {
    const img = new Image();
    img.src =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">${el.outerHTML}</svg>`,
      );
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = 100;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return [25, 55, 100, 145, 175].map((x) => [
      ...ctx.getImageData(x, 50, 1, 1).data,
    ]);
  });
  expect(pixels).toEqual([
    [0, 0, 0, 0],
    [255, 0, 0, 255],
    [255, 0, 0, 255],
    [255, 0, 0, 255],
    [0, 0, 0, 0],
  ]);
  await outer(p)
    .locator(':scope > rect[fill="transparent"]')
    .click({ position: { x: 80, y: 50 } });
  await expect(outer(p)).toHaveAttribute("data-selected", "true");
  await expect(p.getByLabel("配置名", { exact: true })).toHaveValue(view.name!);
});
test("insertion searches source, excludes nested references, duplicates and undoes atomically", async ({
  page: p,
}) => {
  await start(p);
  await insertMenu(p);
  const dialog = p.getByRole("dialog", { name: "画面を埋め込む", exact: true });
  await expect(
    dialog.getByRole("radio", { name: new RegExp(host.name) }),
  ).toBeDisabled();
  await dialog.getByLabel("埋込画面を検索", { exact: true }).fill("循環");
  await dialog.getByRole("radio", { name: source.name, exact: true }).check();
  await btn(p, "埋込配置を追加").click();
  await expect(
    p.locator(".sheet > svg > [data-object-id] [data-screen-view]"),
  ).toHaveCount(3);
  await btn(p, "選択図形を複製").click();
  await expect(
    p.locator(".sheet > svg > [data-object-id] [data-screen-view]"),
  ).toHaveCount(4);
  await btn(p, "元に戻す").click();
  await btn(p, "元に戻す").click();
  await expect(
    p.locator(".sheet > svg > [data-object-id] [data-screen-view]"),
  ).toHaveCount(2);
  await p.locator(`[data-screen-tab="${source.id}"]`).click();
  await insertMenu(p);
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  for (const radio of await dialog.getByRole("radio").all())
    await expect(radio).toBeDisabled();
  await btn(p, "キャンセル").click();
});
test("reference change is guarded by unapplied inputs; copy and cut leave Project and OS clipboard untouched", async ({
  page: p,
}) => {
  const project = structuredClone(sample) as any;
  const empty = {
    id: "0199ff00-0000-7000-8000-000000000005",
    name: "空の画面",
    width: 200,
    height: 100,
    background: "#ffffff",
    objects: [],
    folders: [],
    groups: [],
  };
  project.screens.push(empty);
  await p.addInitScript(() => {
    (window as any).__writes = 0;
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          (window as any).__writes++;
        },
      },
    });
  });
  await start(p, project);
  await p.getByLabel("参照する画面", { exact: true }).selectOption(empty.id);
  await expect(projection(p)).toHaveAttribute("data-screen-view", source.id);
  await btn(p, "変更を適用").click();
  await expect(projection(p)).toHaveAttribute("data-screen-view", empty.id);
  await btn(p, "元に戻す").click();
  await expect(projection(p)).toHaveAttribute("data-screen-view", source.id);
  await editMenu(p, "コピー");
  await expect(p.getByTestId("project-status")).toContainText(
    "埋込画面を含むコピー",
  );
  await editMenu(p, "切り取り");
  await expect(p.getByTestId("project-status")).toContainText(
    "埋込画面を含むコピー",
  );
  expect(await p.evaluate(() => (window as any).__writes)).toBe(0);
  const result = await save(p);
  expect(result.screens[0].objects).toEqual(project.screens[0].objects);
  await p.getByLabel("配置名", { exact: true }).fill("未適用");
  await btn(p, "参照する画面を開く").click();
  await expect(p.getByRole("dialog")).toContainText("未適用");
  await btn(p, "キャンセル").click();
  await expect(projection(p)).toBeVisible();
});
test("used source deletion reports owners and retains the shared references", async ({
  page: p,
}) => {
  await start(p);
  p.on("dialog", (dialog) => dialog.accept());
  await selectPanel(p, "プロジェクト");
  await p
    .locator(`button[data-screen-id="${source.id}"]`)
    .click({ button: "right" });
  await p.getByRole("menuitem", { name: "画面を削除", exact: true }).click();
  await expect(p.getByTestId("project-status")).toContainText("使用中");
  await expect(p.getByTestId("project-status")).toContainText(host.name);
  expect((await save(p)).screens).toHaveLength(2);
});

test("source background and Image share the original through package save and reopen", async ({
  page: p,
}) => {
  await start(p);
  await btn(p, "参照する画面を開く").click();
  await selectPanel(p, "プロジェクト");
  const bytes = Buffer.from(
    await p.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 80;
      c.height = 40;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#e06741";
      ctx.fillRect(0, 0, 80, 40);
      return c.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  let chooser = p.waitForEvent("filechooser");
  await btn(p, "背景画像を選択…").click();
  await (
    await chooser
  ).setFiles({ name: "view.png", mimeType: "image/png", buffer: bytes });
  await expect(
    p.locator(".sheet > svg > [data-background-image]"),
  ).toBeAttached();
  chooser = p.waitForEvent("filechooser");
  await fileCommand(p, "画像を配置");
  await (
    await chooser
  ).setFiles({ name: "same.png", mimeType: "image/png", buffer: bytes });
  await expect(p.locator(".sheet [data-image-frame]")).toHaveCount(1);
  await p.locator(`[data-screen-tab="${host.id}"]`).click();
  await expect(projection(p).locator("[data-background-image]")).toHaveCount(1);
  await expect(projection(p).locator("[data-image-frame]")).toHaveCount(1);
  expect(
    await projection(p).locator("[data-background-image]").getAttribute("href"),
  ).toBe(
    await projection(p).locator("[data-image-frame]").getAttribute("href"),
  );
  const wait = p.waitForEvent("download");
  await p.keyboard.press("Control+s");
  const download = await wait;
  expect(download.suggestedFilename()).toBe("project.bantoscada");
  const archive = await readFile((await download.path())!);
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "embedded.bantoscada",
    mimeType: "application/zip",
    buffer: archive,
  });
  await expect(projection(p).locator("[data-background-image]")).toHaveCount(1);
  await expect(projection(p).locator("[data-image-frame]")).toHaveCount(1);
  const restored = await p.evaluate(
    async (bytes) => {
      const path = "/src/lib/project-package.ts";
      const { readProjectFile } = await import(path);
      const result = await readProjectFile(new Blob([new Uint8Array(bytes)]));
      const project = result.project;
      result.store.dispose();
      return project;
    },
    [...archive],
  );
  expect(restored.assets).toHaveLength(1);
  expect(restored.screens[1].backgroundImage.assetId).toBe(
    restored.screens[1].objects.at(-1).shape.assetId,
  );
});

test("projected Symbols keep saved viewport dimensions instead of adopting source screen size", async ({
  page: p,
}) => {
  const project = structuredClone(sample) as any;
  const symbols = project.screens[1].objects.filter(
    (o: any) => o.shape.type === "symbol",
  );
  symbols[0].width = 180;
  symbols[0].height = 45;
  symbols[1].width = 50;
  symbols[1].height = 90;
  await start(p, project);
  const metrics = await projection(p)
    .locator("[data-symbol-id]")
    .evaluateAll((nodes) =>
      nodes.map((el) => {
        const svg = el as SVGSVGElement;
        const matrix = (
          svg.parentElement as unknown as SVGGraphicsElement
        ).getScreenCTM()!;
        return {
          width: svg.getAttribute("width"),
          height: svg.getAttribute("height"),
          local: {
            a: matrix.inverse().multiply(svg.getScreenCTM()!).a,
            e: matrix.inverse().multiply(svg.getScreenCTM()!).e,
            f: matrix.inverse().multiply(svg.getScreenCTM()!).f,
          },
        };
      }),
    );
  expect(metrics).toHaveLength(2);
  for (let i = 0; i < 2; i++) {
    const definition = project.symbols.find(
      (d: any) => d.id === symbols[i].shape.symbolId,
    );
    const ratio = Math.min(
      symbols[i].width / definition.width,
      symbols[i].height / definition.height,
    );
    expect(Number(metrics[i].width)).toBe(symbols[i].width);
    expect(Number(metrics[i].height)).toBe(symbols[i].height);
    expect(metrics[i].local.a).toBeCloseTo(ratio, 6);
    expect(metrics[i].local.e).toBeCloseTo(
      (symbols[i].width - definition.width * ratio) / 2,
      5,
    );
    expect(metrics[i].local.f).toBeCloseTo(
      (symbols[i].height - definition.height * ratio) / 2,
      5,
    );
  }
});

test("host and projected numeric text consume the same reading snapshot and Quality", async ({
  page: p,
}) => {
  await p.goto("/");
  const result = await p.evaluate(
    async (project) => {
      const sveltePath = "/node_modules/.vite/deps/svelte.js",
        rendererPath = "/src/lib/Renderer.svelte";
      const { mount, unmount, tick } = await import(sveltePath);
      const { default: Renderer } = await import(rendererPath);
      const target = document.createElement("div");
      target.style.cssText =
        "position:fixed;left:0;top:0;width:1280px;height:720px";
      document.body.append(target);
      const tag = "Line.Pump.Speed";
      const host = project.screens[0],
        source = project.screens[1];
      host.objects[0].shape.binding = { externalName: tag };
      source.objects[0].shape.binding = { externalName: tag };
      const snapshots = [];
      try {
        for (const reading of [
          { state: "resolved", quality: "good", numericValue: 42.5 },
          { state: "resolved", quality: "stale", numericValue: 42.5 },
          { state: "disconnected" },
        ]) {
          const app = mount(Renderer, {
            target,
            props: {
              screen: host,
              screens: project.screens,
              symbols: project.symbols,
              readings: new Map([[tag, reading]]),
            },
          });
          await tick();
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          snapshots.push(
            [...target.querySelectorAll("text[data-text-content]")].map(
              (n) => ({
                text: n.textContent,
                tag: n
                  .closest("[data-tag-state]")
                  ?.getAttribute("data-tag-state"),
              }),
            ),
          );
          await unmount(app);
        }
      } finally {
        target.remove();
      }
      return snapshots;
    },
    structuredClone(sample) as any,
  );
  expect(result).toHaveLength(3);
  expect(result[0].filter((x: any) => x.text === "42.5")).toHaveLength(3);
  expect(result[1].filter((x: any) => x.text?.includes("Stale"))).toHaveLength(
    3,
  );
  expect(result[2].filter((x: any) => x.text?.includes("未接続"))).toHaveLength(
    3,
  );
});
