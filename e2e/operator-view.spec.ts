import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/process.project.json" with { type: "json" };
import { openProject } from "./helpers/project-files";

const main = sample.screens[0].id;
const header = sample.operatorFrame.headerScreenId;
const footer = sample.operatorFrame.footerScreenId;
const detail = "0199f200-0000-7000-8000-000000000301";

// 工程図サンプルに、ヘッダーのボタンで移れる2つ目の主画面を足す。
function operatorProject() {
  const project = structuredClone(sample) as any;
  project.screens.push({
    id: detail,
    name: "設備詳細",
    width: 480,
    height: 540,
    background: "#1e293b",
    objects: [],
    folders: [],
    groups: [],
  });
  project.screens
    .find((s: any) => s.id === header)
    .objects.push({
      id: "0199f200-0000-7000-8000-000000000302",
      order: 10,
      x: 424,
      y: 10,
      width: 120,
      height: 40,
      rotation: 0,
      shape: {
        type: "navButton",
        target: { kind: "screen", screenId: detail },
        label: "設備詳細",
        fontSize: 16,
        fill: "#334155",
        textColor: "#f8fafc",
        currentFill: "#0ea5e9",
        currentTextColor: "#0f172a",
      },
    });
  return project;
}

async function open(page: Page, project: object) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await openProject(page, {
    name: "operator-view.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
}
const tab = (page: Page, id: string) =>
  page.locator(`[data-screen-tab="${id}"]`);
const view = (page: Page) => page.getByRole("region", { name: "運転表示" });
const region = (page: Page, role: string) =>
  view(page).locator(`[data-operator-region="${role}"]`);
const navPainting = (page: Page, id: string) =>
  region(page, "header").locator(`[data-object-id="${id}"] [data-nav-button]`);
const toMain = "0199f200-0000-7000-8000-000000000211";
const back = "0199f200-0000-7000-8000-000000000212";
const forward = "0199f200-0000-7000-8000-000000000213";
const clock = "0199f200-0000-7000-8000-000000000214";
const toDetail = "0199f200-0000-7000-8000-000000000302";

test("the operator view shows the frame, keeps its own history and leaves the Designer screen alone", async ({
  page,
}) => {
  await open(page, operatorProject());
  await expect(tab(page, main)).toHaveAttribute("aria-current", "page");
  const entry = page.getByRole("button", { name: "運転表示", exact: true });
  await entry.click();

  // 枠＋主画面だけを出す。ヘッダー・フッターは主画面の幅にそろう。
  await expect(view(page)).toBeVisible();
  await expect(view(page)).toHaveAttribute("data-operator-screen", main);
  // 裏の Designer の UI は操作できない。
  await expect(page.locator(".app-header")).toHaveAttribute("inert", "");
  await expect(region(page, "header").locator("svg").first()).toHaveAttribute(
    "aria-label",
    "運転表示ヘッダー",
  );
  await expect(region(page, "footer").locator("svg").first()).toHaveAttribute(
    "aria-label",
    "運転表示フッター",
  );
  await expect(
    region(page, "header").locator(`[data-object-id="${clock}"] text`).last(),
  ).toHaveText(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  const headerBox = await region(page, "header").boundingBox();
  const mainBox = await region(page, "main").boundingBox();
  const footerBox = await region(page, "footer").boundingBox();
  if (!headerBox || !mainBox || !footerBox)
    throw new Error("frame not laid out");
  expect(Math.abs(headerBox.width - mainBox.width)).toBeLessThan(1);
  expect(Math.abs(footerBox.width - mainBox.width)).toBeLessThan(1);
  // 960×60 のヘッダーは主画面（960×540）と同じ倍率。
  expect(headerBox.height / mainBox.height).toBeCloseTo(60 / 540, 2);
  expect(Math.abs(headerBox.y + headerBox.height - mainBox.y)).toBeLessThan(1);
  expect(Math.abs(mainBox.y + mainBox.height - footerBox.y)).toBeLessThan(1);

  // 現在の画面のボタンを強調し、履歴がないので戻る・進むは押せない。
  await expect(navPainting(page, toMain)).toHaveAttribute(
    "data-nav-current",
    "true",
  );
  await expect(navPainting(page, back)).toHaveAttribute(
    "data-nav-disabled",
    "true",
  );
  await expect(navPainting(page, forward)).toHaveAttribute(
    "data-nav-disabled",
    "true",
  );

  // ヘッダーのボタンで移る。強調は運転表示の現在の画面に従う。
  await region(page, "header")
    .getByRole("button", { name: "設備詳細：設備詳細へ移る" })
    .click();
  await expect(view(page)).toHaveAttribute("data-operator-screen", detail);
  await expect(region(page, "main").locator("svg").first()).toHaveAttribute(
    "aria-label",
    "設備詳細",
  );
  await expect(navPainting(page, toDetail)).toHaveAttribute(
    "data-nav-current",
    "true",
  );
  await expect(navPainting(page, toMain)).not.toHaveAttribute(
    "data-nav-current",
  );
  await expect(navPainting(page, back)).not.toHaveAttribute(
    "data-nav-disabled",
  );
  // 幅の違う主画面でも、枠は主画面の幅にそろう。
  const narrowMain = await region(page, "main").boundingBox();
  const narrowHeader = await region(page, "header").boundingBox();
  expect(Math.abs(narrowHeader!.width - narrowMain!.width)).toBeLessThan(1);

  // 戻る・進む。
  await region(page, "header")
    .getByRole("button", { name: "戻る：前の画面へ戻る" })
    .click();
  await expect(view(page)).toHaveAttribute("data-operator-screen", main);
  await expect(navPainting(page, back)).toHaveAttribute(
    "data-nav-disabled",
    "true",
  );
  await region(page, "header")
    .getByRole("button", { name: "進む：次の画面へ進む" })
    .click();
  await expect(view(page)).toHaveAttribute("data-operator-screen", detail);
  await expect(navPainting(page, forward)).toHaveAttribute(
    "data-nav-disabled",
    "true",
  );

  // Esc で戻る。Designer の画面タブは入口の画面のまま。
  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);
  await expect(tab(page, main)).toHaveAttribute("aria-current", "page");
  await expect(tab(page, detail)).not.toHaveAttribute("aria-current", "page");
  await expect(entry).toBeFocused();
});

test("without a start screen the operator view opens the Designer screen and the exit button returns", async ({
  page,
}) => {
  const project = operatorProject();
  delete project.operatorFrame.startScreenId;
  delete project.operatorFrame.footerScreenId;
  await open(page, project);
  await tab(page, detail).click();
  await expect(tab(page, detail)).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "運転表示", exact: true }).click();
  await expect(view(page)).toHaveAttribute("data-operator-screen", detail);
  await expect(region(page, "footer")).toHaveCount(0);
  await expect(navPainting(page, toDetail)).toHaveAttribute(
    "data-nav-current",
    "true",
  );
  await view(page)
    .getByRole("button", { name: "運転表示を終了（Esc）" })
    .click();
  await expect(view(page)).toHaveCount(0);
  await expect(tab(page, detail)).toHaveAttribute("aria-current", "page");
});
