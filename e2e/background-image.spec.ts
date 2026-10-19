import sample from "../examples/minimal.project.json" with { type: "json" };
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { chooseTheme, selectPanel } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const image = (page: Page) =>
  page.locator(".sheet > svg > image[data-background-image]");
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "プロジェクト");
}
async function png(page: Page, color = "rgba(0,128,255,0.5)") {
  return Buffer.from(
    await page.evaluate((color) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 32;
      const c = canvas.getContext("2d")!;
      c.fillStyle = color;
      c.fillRect(0, 0, 64, 32);
      return canvas.toDataURL("image/png").split(",")[1];
    }, color),
    "base64",
  );
}
async function upload(page: Page, bytes: Buffer) {
  const chooser = page.waitForEvent("filechooser");
  await button(page, "背景画像を選択…").click();
  await (
    await chooser
  ).setFiles({ name: "背景.png", mimeType: "image/png", buffer: bytes });
  await expect(image(page)).toBeAttached();
  await expect(
    page.getByLabel("背景画像を取り込む", { exact: true }),
  ).toBeEnabled();
}
async function download(page: Page) {
  const wait = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return await wait;
}
for (const theme of ["light", "dark"])
  test(`background image fits behind objects, edits explicitly, restores through Undo and exports portable originals in ${theme}`, async ({
    page,
    browser,
  }) => {
    await start(page);
    await chooseTheme(page, theme);
    const bytes = await png(page);
    await upload(page, bytes);
    await expect(image(page)).toHaveAttribute(
      "preserveAspectRatio",
      "xMidYMid meet",
    );
    await expect(image(page)).toHaveAttribute("pointer-events", "none");
    expect(
      await page.locator(".sheet > svg").evaluate((svg) => {
        const nodes = [...svg.children];
        return (
          nodes.findIndex((n) => n.hasAttribute("data-screen-background")) <
            nodes.findIndex((n) => n.hasAttribute("data-background-image")) &&
          nodes.findIndex((n) => n.hasAttribute("data-background-image")) <
            nodes.findIndex((n) => n.hasAttribute("data-object-id"))
        );
      }),
    ).toBe(true);
    await page
      .getByLabel("背景画像の表示方法", { exact: true })
      .selectOption("cover");
    await page
      .getByLabel("背景画像の不透明度（%）", { exact: true })
      .fill("40");
    await expect(image(page)).toHaveAttribute("opacity", "1");
    await button(page, "背景画像の設定を適用").click();
    await expect(image(page)).toHaveAttribute("opacity", "0.4");
    await expect(image(page)).toHaveAttribute(
      "preserveAspectRatio",
      "xMidYMid slice",
    );
    await expect(
      page.locator(".minimap image[data-background-image]"),
    ).toHaveAttribute("opacity", "0.4");
    await button(page, "背景画像を解除").click();
    await expect(image(page)).toHaveCount(0);
    await button(page, "元に戻す").click();
    await expect(image(page)).toHaveAttribute("opacity", "0.4");
    const file = await download(page);
    expect(file.suggestedFilename()).toBe("project.bantoscada");
    const archive = await readFile((await file.path())!);
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
      }),
      other = await context.newPage();
    await start(other);
    await other.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "other.bantoscada",
      mimeType: "application/zip",
      buffer: archive,
    });
    await expect(image(other)).toHaveAttribute("opacity", "0.4");
    await expect(image(other)).toHaveAttribute(
      "preserveAspectRatio",
      "xMidYMid slice",
    );
    const original = await image(other).evaluate(async (element) =>
      Array.from(
        new Uint8Array(
          await (await fetch(element.getAttribute("href")!)).arrayBuffer(),
        ),
      ),
    );
    expect(Buffer.from(original)).toEqual(bytes);
    await button(other, "表示プレビュー").click();
    await expect(image(other)).toHaveAttribute("opacity", "0.4");
    await context.close();
  });
test("removing the last background saves plain JSON and old bytes remain available to Undo", async ({
  page,
}) => {
  await start(page);
  await upload(page, await png(page));
  await button(page, "背景画像を解除").click();
  const file = await download(page);
  expect(file.suggestedFilename()).toBe("project.json");
  const project = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(project.assets).toEqual([]);
  expect(project.screens[0].backgroundImage).toBeUndefined();
  await button(page, "元に戻す").click();
  await expect(image(page)).toBeAttached();
  const src = await image(page).getAttribute("href");
  expect(await page.evaluate(async (src) => (await fetch(src!)).ok, src)).toBe(
    true,
  );
});
test("failed image imports and asset-only JSON never replace the current drawing", async ({
  page,
}) => {
  await start(page);
  await upload(page, await png(page));
  const before = await image(page).getAttribute("href");
  await page.getByLabel("背景画像を取り込む", { exact: true }).setInputFiles({
    name: "fake.png",
    mimeType: "image/png",
    buffer: Buffer.from("bad"),
  });
  await expect(page.getByTestId("project-status")).toContainText(
    "画像取込エラー",
  );
  await expect(image(page)).toHaveAttribute("href", before!);
  const archive = await download(page),
    bytes = await readFile((await archive.path())!);
  const plain = await page.evaluate(async (bytes) => {
    const path = "/src/lib/project-package.ts";
    const { readProjectFile } = await import(path);
    const candidate = await readProjectFile(new Blob([new Uint8Array(bytes)]));
    const json = JSON.stringify(candidate.project);
    candidate.store.dispose();
    return json;
  }, Array.from(bytes));
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "missing-images.json",
    mimeType: "application/json",
    buffer: Buffer.from(plain),
  });
  await expect(page.getByTestId("project-status")).toContainText("JSON単体");
  await expect(image(page)).toHaveAttribute("href", before!);
});
test("asynchronous package export writes its snapshot and leaves later edits unsaved", async ({
  page,
}) => {
  await start(page);
  await upload(page, await png(page));
  await page.evaluate(() => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      await new Promise<void>(
        (resolve) => ((window as any).releaseSave = resolve),
      );
      crypto.subtle.digest = original;
      return original(...args);
    };
  });
  const wait = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseSave))
    .toBe("function");
  await expect(page.getByTestId("save-state")).toContainText("書出し中");
  await page.getByLabel("背景画像の不透明度（%）", { exact: true }).fill("20");
  await button(page, "背景画像の設定を適用").click();
  await expect(image(page)).toHaveAttribute("opacity", "0.2");
  await page.evaluate(() => (window as any).releaseSave());
  const archive = await readFile((await (await wait).path())!);
  const opacity = await page.evaluate(async (bytes) => {
    const path = "/src/lib/project-package.ts";
    const { readProjectFile } = await import(path);
    const candidate = await readProjectFile(new Blob([new Uint8Array(bytes)]));
    const opacity = candidate.project.screens[0].backgroundImage.opacity;
    candidate.store.dispose();
    return opacity;
  }, Array.from(archive));
  expect(opacity).toBe(1);
  await expect(
    page.getByText("未書き出しの変更あり", { exact: true }),
  ).toBeVisible();
});
test("a late image decode after Project replacement cannot install into the new Project", async ({
  page,
}) => {
  await start(page);
  const bytes = await png(page);
  await page.evaluate(() => {
    const original = createImageBitmap;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    (window as any).imageHashDone = false;
    crypto.subtle.digest = async (...args) => {
      const result = await digest(...args);
      (window as any).imageHashDone = true;
      return result;
    };
    window.createImageBitmap = (...args: any[]) =>
      new Promise((resolve) => {
        (window as any).resumeImage = async () => {
          window.createImageBitmap = original;
          resolve(await (original as any)(...args));
        };
      });
  });
  await page.getByLabel("背景画像を取り込む", { exact: true }).setInputFiles({
    name: "delayed.png",
    mimeType: "image/png",
    buffer: bytes,
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).resumeImage))
    .toBe("function");
  await page.keyboard.press("Control+n");
  await expect(
    page.getByRole("heading", { name: "新しいProject", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).resumeImage());
  await expect
    .poll(() => page.evaluate(() => (window as any).imageHashDone))
    .toBe(true);
  await expect(
    page.getByLabel("背景画像を取り込む", { exact: true }),
  ).toBeEnabled();
  await expect(image(page)).toHaveCount(0);
  const file = await download(page),
    project = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(project.assets).toEqual([]);
  expect(project.screens[0].backgroundImage).toBeUndefined();
});

test("leaving and returning to the same mode permanently invalidates a pending image import", async ({
  page,
}) => {
  await start(page);
  const bytes = await png(page);
  await page.evaluate(() => {
    const original = createImageBitmap;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    (window as any).imageHashDone = false;
    crypto.subtle.digest = async (...args) => {
      const result = await digest(...args);
      (window as any).imageHashDone = true;
      return result;
    };
    window.createImageBitmap = (...args: any[]) =>
      new Promise((resolve) => {
        (window as any).resumeImage = async () => {
          window.createImageBitmap = original;
          resolve(await (original as any)(...args));
        };
      });
  });
  await page.getByLabel("背景画像を取り込む", { exact: true }).setInputFiles({
    name: "delayed.png",
    mimeType: "image/png",
    buffer: bytes,
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).resumeImage))
    .toBe("function");
  await button(page, "表示プレビュー").click();
  await button(page, "編集").click();
  await page.evaluate(() => (window as any).resumeImage());
  await expect
    .poll(() => page.evaluate(() => (window as any).imageHashDone))
    .toBe(true);
  await expect(
    page.getByLabel("背景画像を取り込む", { exact: true }),
  ).toBeEnabled();
  await expect(image(page)).toHaveCount(0);
  const file = await download(page);
  expect(file.suggestedFilename()).toBe("project.json");
});
test("IME confirmation does not submit the background settings", async ({
  page,
}) => {
  await start(page);
  const bytes = await png(page);
  await upload(page, bytes);
  const alpha = page.getByLabel("背景画像の不透明度（%）", { exact: true });
  await alpha.fill("35");
  await alpha.dispatchEvent("compositionstart");
  await alpha.press("Enter");
  await expect(image(page)).toHaveAttribute("opacity", "1");
  await alpha.dispatchEvent("compositionend");
  await button(page, "背景画像の設定を適用").click();
  await expect(image(page)).toHaveAttribute("opacity", "0.35");
  const url = await image(page).getAttribute("href");
  await upload(page, bytes);
  await expect(image(page)).toHaveAttribute("opacity", "0.35");
  await expect(image(page)).toHaveAttribute("href", url!);
  await button(page, "元に戻す").click();
  await expect(image(page)).toHaveAttribute("opacity", "1");
});

test("switching away and back to the same screen does not revive an obsolete image request", async ({
  page,
}) => {
  await start(page);
  const project: any = structuredClone(sample),
    second = "0199fc00-0000-7000-8000-000000001900";
  project.screens.push({
    ...project.screens[0],
    id: second,
    name: "別画面",
    objects: [],
    folders: [],
  });
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "two.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  const bytes = await png(page);
  await page.evaluate(() => {
    const original = createImageBitmap;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    (window as any).imageHashDone = false;
    crypto.subtle.digest = async (...args) => {
      const result = await digest(...args);
      (window as any).imageHashDone = true;
      return result;
    };
    window.createImageBitmap = (...args: any[]) =>
      new Promise((resolve) => {
        (window as any).resumeImage = async () => {
          window.createImageBitmap = original;
          resolve(await (original as any)(...args));
        };
      });
  });
  await page.getByLabel("背景画像を取り込む", { exact: true }).setInputFiles({
    name: "delayed.png",
    mimeType: "image/png",
    buffer: bytes,
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).resumeImage))
    .toBe("function");
  await page.locator(`button[data-screen-id="${second}"]`).click();
  await page
    .locator(`button[data-screen-id="${project.screens[0].id}"]`)
    .click();
  await page.evaluate(() => (window as any).resumeImage());
  await expect
    .poll(() => page.evaluate(() => (window as any).imageHashDone))
    .toBe(true);
  await expect(
    page.getByLabel("背景画像を取り込む", { exact: true }),
  ).toBeEnabled();
  await expect(image(page)).toHaveCount(0);
  expect((await download(page)).suggestedFilename()).toBe("project.json");
});

test("clearing Redo releases the last original that no current or Undo snapshot needs", async ({
  page,
}) => {
  await start(page);
  await upload(page, await png(page));
  const url = await image(page).getAttribute("href");
  await button(page, "元に戻す").click();
  await expect(image(page)).toHaveCount(0);
  expect(await page.evaluate(async (url) => (await fetch(url!)).ok, url)).toBe(
    true,
  );
  await page.getByLabel("画面の背景色", { exact: true }).fill("#eeeeee");
  await button(page, "画面設定を適用").click();
  await expect(button(page, "やり直す")).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(async (url) => {
        try {
          await fetch(url!);
          return true;
        } catch {
          return false;
        }
      }, url),
    )
    .toBe(false);
});
