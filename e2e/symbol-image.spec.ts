import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/symbol-image.project.json" with { type: "json" };
import {
  chooseTheme,
  fileCommand,
  mainCanvas,
  selectPanel,
} from "./helpers/designer";
import {
  openProject,
  downloadProject,
  downloadBytes,
} from "./helpers/project-files";
const original = await readFile(
  new URL("../examples/assets/symbol-image.png", import.meta.url),
);
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function pack(page: Page, project: object) {
  return Buffer.from(
    await page.evaluate(
      async ({ project, bytes }) => {
        const a = "/src/lib/image-assets.ts",
          p = "/src/lib/project-package.ts";
        const { AssetStore } = await import(a),
          { writeProjectPackage } = await import(p);
        const store = new AssetStore();
        try {
          await store.put(
            new Blob([new Uint8Array(bytes)]),
            "symbol-image.png",
            (project as any).assets[0],
          );
          return [
            ...new Uint8Array(
              await (await writeProjectPackage(project, store)).arrayBuffer(),
            ),
          ];
        } finally {
          store.dispose();
        }
      },
      { project, bytes: [...original] },
    ),
  );
}
async function load(page: Page, project: object = sample) {
  await openProject(page, {
    name: "symbol-image.bantoscada",
    mimeType: "application/octet-stream",
    buffer: await pack(page, project),
  });
  await expect(mainCanvas(page).locator("image[data-image-frame]")).toHaveCount(
    1,
  );
}
async function pixels(page: Page) {
  return mainCanvas(page)
    .locator(
      `[data-object-id="${sample.screens[0].objects[0].id}"] > [data-object-rotation]`,
    )
    .evaluate(async (element) => {
      const clone = element.cloneNode(true) as Element;
      for (const image of clone.querySelectorAll("image")) {
        const blob = await (await fetch(image.getAttribute("href")!)).blob();
        const url = await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.readAsDataURL(blob);
        });
        image.setAttribute("href", url);
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320">${clone.outerHTML}</svg>`;
      const img = new Image();
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 320;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 640, 320);
      ctx.drawImage(img, 0, 0);
      return [160, 320, 480].map((x) => [
        ...ctx.getImageData(x, 160, 1, 1).data,
      ]);
    });
}
for (const theme of ["light", "dark"] as const)
  test(`Symbol images retain original RGB, alpha and interleaved paint order in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await button(page, "編集").click();
    await chooseTheme(page, theme);
    for (const mode of ["monochrome", "definition"]) {
      const project = structuredClone(sample);
      project.screens[0].objects[0].shape.colorMode = mode;
      await load(page, project);
      const actual = await pixels(page);
      const expected =
        mode === "monochrome"
          ? [
              [236, 179, 159, 255],
              [159, 255, 159, 255],
              [159, 255, 198, 255],
            ]
          : [
              [255, 102, 102, 255],
              [64, 64, 255, 255],
              [178, 255, 255, 255],
            ];
      for (let i = 0; i < 3; i++)
        for (let c = 0; c < 4; c++)
          expect(Math.abs(actual[i][c] - expected[i][c])).toBeLessThanOrEqual(
            2,
          );
      await expect(
        page
          .getByRole("region", { name: "ミニマップ", exact: true })
          .locator("image[data-image-frame]"),
      ).toHaveCount(1);
      await selectPanel(page, "部品");
      await expect(
        page
          .getByRole("region", { name: "部品パレット", exact: true })
          .locator("image[data-image-frame]"),
      ).toHaveCount(1);
      if (process.env.SCADA_SCREENSHOT_DIR && mode === "monochrome")
        await page.screenshot({
          path: `${process.env.SCADA_SCREENSHOT_DIR}/symbol-image-${theme}.png`,
        });
      await button(page, "表示プレビュー").click();
      await expect(
        mainCanvas(page).locator("image[data-image-frame]"),
      ).toHaveCount(1);
      await button(page, "編集").click();
    }
  });
test("Symbol images are copied with original bytes into another Project and one Undo restores the target", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await button(page, "編集").click();
  await load(page);
  await selectPanel(page, "レイヤー");
  await page
    .locator(`[data-layer-id="${sample.screens[0].objects[0].id}"]`)
    .click();
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("Control+c");
  await expect(page.getByTestId("project-status")).toContainText(
    "コピーしました",
  );
  const fragment = await page.evaluate(async () =>
    JSON.parse(await navigator.clipboard.readText()),
  );
  expect(fragment.images).toHaveLength(1);
  expect(fragment.project.symbols).toHaveLength(1);
  await fileCommand(page, "新しいProject");
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  await page.keyboard.press("Control+v");
  await expect(mainCanvas(page).locator("image[data-image-frame]")).toHaveCount(
    1,
  );
  const bytes = await downloadBytes(await downloadProject(page));
  const saved = await page.evaluate(
    async (data) => {
      const path = "/src/lib/project-package.ts";
      const { readProjectFile } = await import(path);
      const result = await readProjectFile(new Blob([new Uint8Array(data)]));
      try {
        return {
          project: result.project,
          bytes: [
            ...new Uint8Array(
              await result.store
                .blob(result.project.assets[0].sha256)
                .arrayBuffer(),
            ),
          ],
        };
      } finally {
        result.store.dispose();
      }
    },
    [...bytes],
  );
  expect(saved.bytes).toEqual([...original]);
  expect(saved.project.symbols).toHaveLength(1);
  expect(saved.project.assets).toHaveLength(1);
  await button(page, "元に戻す").click();
  await expect(mainCanvas(page).locator("image[data-image-frame]")).toHaveCount(
    0,
  );
  await button(page, "やり直す").click();
  await expect(mainCanvas(page).locator("image[data-image-frame]")).toHaveCount(
    1,
  );
});
test("embedded and popup screen projections include Symbol images", async ({
  page,
}) => {
  await page.goto("/");
  await button(page, "編集").click();
  const project = structuredClone(sample) as any;
  const source = structuredClone(project.screens[0]);
  source.id = "0199fc00-0000-7000-8000-000000000020";
  source.name = "画像の参照元";
  project.screens[0].objects = [
    {
      id: "0199fc00-0000-7000-8000-000000000021",
      order: 0,
      x: 0,
      y: 0,
      width: 800,
      height: 450,
      rotation: 0,
      shape: { type: "screenView", screenId: source.id, fit: "contain" },
    },
  ];
  project.screens.push(source);
  await load(page, project);
  await expect(
    mainCanvas(page).locator("[data-screen-view] image[data-image-frame]"),
  ).toHaveCount(1);
  await button(page, "表示プレビュー").click();
  await button(page, "画面を小窓で表示確認").click();
  const dialog = page.getByRole("dialog", {
    name: "画面を小窓で表示確認",
    exact: true,
  });
  await dialog.locator(`input[value="${source.id}"]`).check();
  await dialog.getByRole("button", { name: "小窓を表示", exact: true }).click();
  await expect(
    page.locator(`[data-preview-popup="${source.id}"] image[data-image-frame]`),
  ).toHaveCount(1);
});

test("the portable example opens with native decode and saves the declared Project and original intact", async ({
  page,
}) => {
  await page.goto("/");
  await button(page, "編集").click();
  await openProject(page, "examples/symbol-image.bantoscada");
  await expect(mainCanvas(page).locator("image[data-image-frame]")).toHaveCount(
    1,
  );
  const bytes = await downloadBytes(await downloadProject(page));
  const result = await page.evaluate(
    async (data) => {
      const path = "/src/lib/project-package.ts";
      const { readProjectFile } = await import(path);
      const result = await readProjectFile(new Blob([new Uint8Array(data)]));
      try {
        return {
          project: result.project,
          bytes: [
            ...new Uint8Array(
              await result.store
                .blob(result.project.assets[0].sha256)
                .arrayBuffer(),
            ),
          ],
        };
      } finally {
        result.store.dispose();
      }
    },
    [...bytes],
  );
  expect(result.project).toEqual(sample);
  expect(result.bytes).toEqual([...original]);
});

test("definition editing displays the image while unsupported image authoring controls stay disabled", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await openProject(page, "examples/symbol-image.bantoscada");
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await selectPanel(page, "レイヤー");
  await page
    .locator(`[data-layer-id="${sample.symbols[0].objects[1].id}"]`)
    .click();
  await expect(mainCanvas(page).locator("image[data-image-frame]")).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("combobox", { name: "画像の表示方式", exact: true }),
  ).toBeDisabled();
  await expect(button(page, "画像を差し替え…")).toBeDisabled();
  await expect(
    page
      .getByRole("form", { name: "画像のトリミング", exact: true })
      .locator('input[name="cropX"]'),
  ).toBeDisabled();
});
