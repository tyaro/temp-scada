import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import fixtures from "../examples/read-display-cases.json" with { type: "json" };
import { chooseTheme, mainCanvas } from "./helpers/designer";
import { openProject, downloadBytes } from "./helpers/project-files";

/** Only the test entry module gets a fixture source; production has no global hook. */
async function fixtureEntry(page: Page) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const mount =
      /mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);/;
    expect(original).toMatch(mount);
    const injected = `
      import { createSubscriber } from "/node_modules/.vite/deps/svelte_reactivity.js";
      let notifySource = () => {};
      const trackSource = createSubscriber(update => { notifySource = update; return () => {}; });
      const h = window.__readHarness = {deliveries: [], subscriptions: [], throwSubscribe: false, throwUnsubscribe: false, ended: 0};
      const makeSource = () => ({subscribe(project, begin) {
        h.subscriptions.push(project);
        h.begin = begin;
        h.delivery = begin(); h.deliveries.push(h.delivery);
        if (h.throwSubscribe) throw Error("test source failure");
        return () => {h.ended++; if (h.throwUnsubscribe) throw Error("test cleanup failure");};
      }});
      let source = makeSource();
      h.replaceSource = () => {source = makeSource(); notifySource();};
      h.restart = () => {h.delivery = h.begin(); h.deliveries.push(h.delivery);};
      mount(App, {target: document.getElementById("app"), props: {get readSource() {trackSource(); return source;}}});
    `;
    await route.fulfill({ response, body: original.replace(mount, injected) });
  });
}

async function send(
  page: Page,
  name: string,
  sequence: number,
  generation: number | null,
) {
  const update = structuredClone(
    fixtures.find((fixture) => fixture.name === name)!.update,
  );
  update.sequence = sequence;
  update.sdkGeneration = generation;
  return page.evaluate(
    (update) => (window as any).__readHarness.delivery.receive(update),
    update,
  );
}

for (const theme of ["light", "dark"] as const) {
  test(`App distributes a single validated read session to main, embedded, popup and equipment in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await fixtureEntry(page);
    await page.goto("/");
    await chooseTheme(page, theme);
    const input = {
      name: "read-presentation.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    };
    await openProject(page, input);
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    const main = mainCanvas(page);
    const numbers = main.locator('[data-tag-name="Demo.Number"]');
    await expect(numbers).toHaveCount(2);
    expect(await send(page, "good", 1, 1)).toBe(true);
    for (const number of await numbers.all()) {
      await expect(number).toHaveAttribute("data-tag-state", "good");
      await expect(number.locator("[data-text-content]")).toHaveText("0");
      await expect(number).toHaveAttribute("data-tag-source", "real");
    }
    const slots = main.locator(
      `[data-object-id="${sample.screens[0].objects[0].id}"] [data-tag-name="current"], [data-source-object-id="${sample.screens[1].objects[0].id}"] [data-tag-name="current"]`,
    );
    await expect(slots).toHaveCount(2);
    for (const slot of await slots.all())
      await expect(slot).toHaveAttribute("data-tag-state", "good");
    // Preserve actual mounted nodes across every publication below.
    await numbers
      .first()
      .evaluate((node) => ((window as any).__numberNode = node));
    await page
      .getByRole("button", { name: "画面を小窓で表示確認", exact: true })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "画面を小窓で表示確認",
      exact: true,
    });
    await dialog.locator(`input[value="${sample.screens[0].id}"]`).check();
    await dialog
      .getByRole("button", { name: "小窓を表示", exact: true })
      .click();
    await page
      .getByRole("button", { name: "機器の読取詳細", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "機器の読取詳細を開く",
      exact: true,
    });
    await dialog.locator(`input[value="${sample.equipment[0].id}"]`).check();
    await dialog
      .getByRole("button", { name: "小窓を表示", exact: true })
      .click();
    const popupNumbers = page.locator(
      '[data-popup-kind="screen"] [data-tag-name="Demo.Number"]',
    );
    const detail = page.locator(
      '[data-popup-kind="equipment"] [data-equipment-slot="current"]',
    );
    await expect(popupNumbers).toHaveCount(2);
    for (const number of await popupNumbers.all())
      await expect(number).toHaveAttribute("data-tag-state", "good");
    await expect(detail).toHaveAttribute("data-slot-state", "good");
    // The second equipment is intentionally unresolved while the first stays live.
    await expect(
      main.locator('[data-tag-state="unresolved"]').first(),
    ).toBeVisible();
    let sequence = 2,
      generation = 2;
    for (const [name, state] of [
      ["simulation", "good"],
      ["stale", "stale"],
      ["bad", "bad"],
      ["waiting", "unresolved"],
      ["disconnected", "disconnected"],
    ]) {
      expect(
        await send(
          page,
          name,
          sequence++,
          name === "disconnected" ? null : generation++,
        ),
      ).toBe(true);
      for (const root of [numbers, popupNumbers, slots])
        for (const node of await root.all())
          await expect(node).toHaveAttribute("data-tag-state", state);
      await expect(detail).toHaveAttribute("data-slot-state", state);
      if (name === "simulation") {
        for (const node of await numbers.all())
          await expect(node).toContainText("SIM · 12.5");
        await expect(detail).toContainText("SIM");
        await page.screenshot({
          path: info.outputPath(`read-display-${theme}.png`),
        });
      }
      if (name === "waiting" || name === "disconnected") {
        for (const node of await numbers.all())
          await expect(node).not.toHaveAttribute("data-tag-source");
        await expect(detail.locator(".origin")).toHaveCount(0);
      }
    }
    await numbers.first().evaluate((node) => {
      if (node !== (window as any).__numberNode)
        throw Error("read updates remounted the numeric Text");
    });
    expect(await send(page, "good", sequence++, generation++)).toBe(true);
    const corrupt = structuredClone(fixtures[0].update);
    corrupt.sequence = sequence++;
    corrupt.sdkGeneration = generation;
    corrupt.slots.slots.pop();
    expect(
      await page.evaluate(
        (payload) => (window as any).__readHarness.delivery.receive(payload),
        corrupt,
      ),
    ).toBe(false);
    await expect(numbers.first()).toHaveAttribute("data-tag-state", "invalid");
    await expect(detail).toHaveAttribute("data-slot-state", "invalid");
    await page.evaluate(() => (window as any).__readHarness.restart());
    expect(await send(page, "good", 1, 1)).toBe(true);
    await page.evaluate(() => {
      const h = (window as any).__readHarness;
      h.previous = h.delivery;
      h.delivery.close();
    });
    expect(await send(page, "good", 999, 999)).toBe(false);
    await expect(numbers.first()).toHaveAttribute(
      "data-tag-state",
      "disconnected",
    );
    await page.evaluate(() => (window as any).__readHarness.restart());
    expect(await send(page, "good", 1, 1)).toBe(true);
    await page.evaluate(() => {
      const h = (window as any).__readHarness;
      h.previous.close(); // a retired source cannot close a new delivery
      h.previous = h.delivery;
      h.replaceSource();
    });
    await expect(numbers.first()).toHaveAttribute(
      "data-tag-state",
      "disconnected",
    );
    const old = structuredClone(fixtures[0].update);
    old.sequence = 999;
    expect(
      await page.evaluate(
        (payload) => (window as any).__readHarness.previous.receive(payload),
        old,
      ),
    ).toBe(false);
    expect(await send(page, "good", 1, 1)).toBe(true);
    await page.evaluate(() => {
      const h = (window as any).__readHarness;
      h.previous = h.delivery;
      h.subscriptions.at(-1).manifest.name = "mutated by source";
      h.throwUnsubscribe = true;
    });
    const pending = page.waitForEvent("download");
    await page.keyboard.press("ControlOrMeta+s");
    const saved = JSON.parse((await downloadBytes(await pending)).toString());
    expect(saved).toEqual(sample);
    // Reopening identical IDs/revision still retires all previous callbacks.
    await openProject(page, input);
    expect(
      await page.evaluate(
        (payload) => (window as any).__readHarness.previous.receive(payload),
        old,
      ),
    ).toBe(false);
    await expect(
      mainCanvas(page).locator('[data-tag-name="Demo.Number"]').first(),
    ).toHaveAttribute("data-tag-state", "disconnected");
    expect(await send(page, "good", 1, 1)).toBe(true);
    await page.evaluate(
      () => ((window as any).__readHarness.throwSubscribe = true),
    );
    await openProject(page, input);
    await expect(
      mainCanvas(page).locator('[data-tag-name="Demo.Number"]').first(),
    ).toHaveAttribute("data-tag-state", "invalid");
  });
}
