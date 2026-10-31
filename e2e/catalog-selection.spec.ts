import { test, expect, type Page } from "@playwright/test";
import fixture from "../examples/catalog-view.json" with { type: "json" };
import equipment from "../examples/equipment.project.json" with { type: "json" };
import { chooseTheme, selectPanel } from "./helpers/designer";
import { openProject, downloadBytes } from "./helpers/project-files";

const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "タグを選択", exact: true });
const choose = (page: Page) =>
  dialog(page).getByRole("button", { name: "選択して入力", exact: true });

async function entry(page: Page) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const mount =
      /mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);/;
    expect(original).toMatch(mount);
    const injected = `
      import { createSubscriber } from "/node_modules/.vite/deps/svelte_reactivity.js";
      let notify = () => {};
      const track = createSubscriber(update => {notify = update; return () => {};});
      const h = window.__catalogHarness = { throwSubscribe: false, throwUnsubscribe: false };
      const makeSource = () => ({subscribe(project, begin) {
        h.project = project; h.begin = begin; h.delivery = begin();
        if (h.throwSubscribe) throw Error("test subscribe failure");
        return () => {if(h.throwUnsubscribe) throw Error("test cleanup failure");};
      }});
      let source = makeSource();
      h.replace = () => {h.previous = h.delivery; source = makeSource(); notify();};
      h.restart = () => {h.previous = h.delivery; h.delivery = h.begin();};
      mount(App, {target: document.getElementById("app"), props: {get catalogSource() {track(); return source;}}});
    `;
    await route.fulfill({ response, body: original.replace(mount, injected) });
  });
}
async function publish(page: Page) {
  return page.evaluate((view) => {
    const h = (window as any).__catalogHarness;
    view.projectId = h.project.manifest.projectId;
    view.projectRevision = h.project.manifest.projectRevision;
    return h.delivery.receive(view);
  }, structuredClone(fixture.view));
}

for (const theme of ["light", "dark"] as const) {
  test(`Host catalog selects Text and bool/number slots without retaining old candidates in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await entry(page);
    await page.goto("/");
    await chooseTheme(page, theme);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await selectPanel(page, "レイヤー");
    await page
      .getByRole("navigation", { name: "図形一覧" })
      .getByRole("button", { name: "text · 5", exact: true })
      .click();
    const button = page.getByRole("button", {
      name: "タグを選択",
      exact: true,
    });
    const field = page.getByLabel("表示タグ（外部名）", { exact: true });
    await expect(button).toBeDisabled();
    await field.fill("keep.manual");
    expect(await publish(page)).toBe(true);
    await button.click();
    await expect(dialog(page)).toContainText("タグ一覧の取得時点");
    await expect(
      dialog(page).getByRole("treeitem", { name: /運転/ }),
    ).toHaveCount(0);
    await dialog(page).getByLabel("互換タグのみ", { exact: true }).uncheck();
    await dialog(page)
      .getByRole("treeitem", { name: /無効数値/ })
      .click();
    await expect(choose(page)).toBeDisabled();
    await dialog(page)
      .getByRole("treeitem", { name: /未知型/ })
      .click();
    await expect(choose(page)).toBeDisabled();
    await dialog(page)
      .getByLabel("タグ候補を検索", { exact: true })
      .fill("opaque-level");
    await dialog(page).getByRole("treeitem", { name: /液位/ }).click();
    await expect(field).toHaveValue("keep.manual");
    await page.screenshot({ path: info.outputPath(`catalog-${theme}.png`) });
    await page.evaluate(() => (window as any).__catalogHarness.restart());
    await expect(dialog(page)).toBeHidden();
    await expect(button).toBeDisabled();
    await expect(field).toHaveValue("keep.manual");
    expect(
      await page.evaluate(
        (view) => (window as any).__catalogHarness.previous.receive(view),
        fixture.view,
      ),
    ).toBe(false);
    expect(await publish(page)).toBe(true);
    await button.click();
    await dialog(page).getByRole("treeitem", { name: /液位/ }).click();
    await choose(page).click();
    await expect(field).toHaveValue("opaque-level");
    await page.getByRole("button", { name: "変更を適用", exact: true }).click();
    const pending = page.waitForEvent("download");
    await page.keyboard.press("ControlOrMeta+s");
    const saved = JSON.parse((await downloadBytes(await pending)).toString());
    expect(
      saved.screens[0].objects.find((o: any) => o.shape.binding)?.shape.binding,
    ).toEqual({ externalName: "opaque-level" });
    expect(JSON.stringify(saved)).not.toMatch(
      /catalogRevision|collectionMode|opaque-running|D100/,
    );

    await openProject(page, {
      name: "equipment.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(equipment)),
    });
    await selectPanel(page, "プロジェクト");
    const library = page.getByRole("region", { name: "機器台帳", exact: true });
    await library
      .locator(`[data-equipment-choice="${equipment.equipment[0].id}"]`)
      .click();
    const form = page.getByRole("form", {
      name: "機器情報と割付",
      exact: true,
    });
    const boolButton = form.getByRole("button", {
      name: "runningのタグを選択",
      exact: true,
    });
    await expect(boolButton).toBeDisabled();
    expect(await publish(page)).toBe(true);
    await boolButton.click();
    await expect(
      dialog(page).getByRole("treeitem", { name: /液位/ }),
    ).toHaveCount(0);
    await dialog(page).getByRole("treeitem", { name: /運転/ }).click();
    await choose(page).click();
    await expect(form.locator('input[name="tag:running"]')).toHaveValue(
      "opaque-running",
    );
    await expect(form.locator('select[name="state:running"]')).toHaveValue(
      "assigned",
    );
    await form
      .getByRole("button", { name: "currentのタグを選択", exact: true })
      .click();
    await dialog(page).getByRole("treeitem", { name: /液位/ }).click();
    await choose(page).click();
    await expect(form.locator('input[name="tag:current"]')).toHaveValue(
      "opaque-level",
    );
    await form
      .getByRole("button", { name: "機器情報と割付を適用", exact: true })
      .click();
    const equipmentDownload = page.waitForEvent("download");
    await page.keyboard.press("ControlOrMeta+s");
    const savedEquipment = JSON.parse(
      (await downloadBytes(await equipmentDownload)).toString(),
    );
    expect(savedEquipment.equipment[0].bindings).toEqual([
      { slotName: "running", externalName: "opaque-running" },
      { slotName: "current", externalName: "opaque-level" },
    ]);
    expect(JSON.stringify(savedEquipment)).not.toMatch(
      /catalogRevision|collectionMode|future-type/,
    );
    expect(await publish(page)).toBe(true);
    await boolButton.click();
    await page.evaluate(() => {
      const h = (window as any).__catalogHarness;
      h.delivery.close();
    });
    await expect(dialog(page)).toBeHidden();
    await expect(form.locator('input[name="tag:running"]')).toHaveValue(
      "opaque-running",
    );
    await expect(boolButton).toBeDisabled();
    await page.evaluate(() => (window as any).__catalogHarness.restart());
    expect(await publish(page)).toBe(true);
    await page.evaluate(() => (window as any).__catalogHarness.replace());
    await expect(boolButton).toBeDisabled();
    expect(
      await page.evaluate(
        (view) => (window as any).__catalogHarness.previous.receive(view),
        fixture.view,
      ),
    ).toBe(false);
    expect(await publish(page)).toBe(true);
    await page.evaluate(() => {
      const h = (window as any).__catalogHarness;
      h.previous.close();
    });
    await expect(boolButton).toBeEnabled();
    await page.evaluate(() => {
      const h = (window as any).__catalogHarness;
      h.throwSubscribe = h.throwUnsubscribe = true;
      h.replace();
    });
    await expect(boolButton).toBeDisabled();
    await expect(form.locator('input[name="tag:current"]')).toHaveValue(
      "opaque-level",
    );
  });
}
