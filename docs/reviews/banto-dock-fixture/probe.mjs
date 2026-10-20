import { chromium, expect } from "__PLAYWRIGHT_MODULE__";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
const results = [];
async function probe(name, run) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto("http://127.0.0.1:__PORT__");
    await expect(page.getByLabel("Memo a", { exact: true })).toBeVisible();
    results.push({ name, ...(await run(page)), pageErrors: errors });
  } finally {
    await page.close();
  }
}
const input = (p) => p.getByLabel("Memo a", { exact: true });
try {
  await probe("floating move retains draft and DOM", async (p) => {
    await input(p).fill("unsaved");
    const old = await input(p).elementHandle();
    await p.evaluate(() => evaluation.dock.move("a", 20, 20, 1000, 650));
    await expect(input(p)).toHaveValue("unsaved");
    return {
      sameDOM: await input(p).evaluate((el, old) => el === old, old),
      dirty: await p.evaluate(() => evaluation.guard.count),
    };
  });
  await probe("floating to docked rebuilds draft form", async (p) => {
    await input(p).fill("unsaved");
    const old = await input(p).elementHandle();
    await expect(p.locator("[data-dirty]")).toHaveText("dirty=1");
    await p.getByRole("button", { name: "Dock A", exact: true }).click();
    await expect(input(p)).toBeAttached();
    return {
      sameDOM: await input(p).evaluate((el, old) => el === old, old),
      text: await input(p).inputValue(),
      dirty: await p.evaluate(() => evaluation.guard.count),
      oldConnected: await old.evaluate((el) => el.isConnected),
    };
  });
  await probe("close and reopen rebuilds draft form", async (p) => {
    await input(p).fill("unsaved");
    const old = await input(p).elementHandle();
    await p.getByRole("button", { name: "Close A", exact: true }).click();
    await expect(input(p)).toHaveCount(0);
    const closedDirty = await p.evaluate(() => evaluation.guard.count);
    await p.getByRole("button", { name: "Open A", exact: true }).click();
    await expect(input(p)).toBeAttached();
    return {
      sameDOM: await input(p).evaluate((el, old) => el === old, old),
      text: await input(p).inputValue(),
      closedDirty,
      dirty: await p.evaluate(() => evaluation.guard.count),
    };
  });
  await probe("inactive keyed tab discards draft form", async (p) => {
    await p.evaluate(() => {
      evaluation.dock.close("a");
      evaluation.dock.close("d");
    });
    const b = p.getByLabel("Memo b", { exact: true });
    await b.fill("unsaved B");
    await expect(p.locator("[data-dirty]")).toHaveText("dirty=1");
    const old = await b.elementHandle();
    await p.getByRole("button", { name: "Tab C", exact: true }).click();
    await expect(b).toHaveCount(0);
    await p.getByRole("button", { name: "Tab B", exact: true }).click();
    return {
      sameDOM: await b.evaluate((el, old) => el === old, old),
      text: await b.inputValue(),
      dirty: await p.evaluate(() => evaluation.guard.count),
    };
  });
  await probe("resize Escape does not roll back", async (p) => {
    const h = p
      .getByRole("dialog", { name: "A", exact: true })
      .locator(".handle-se");
    const b = await h.boundingBox();
    const before = await p.evaluate(
      () => evaluation.dock.layout.floating.find((w) => w.id === "a").width,
    );
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.mouse.move(b.x + b.width / 2 + 70, b.y + b.height / 2 + 20);
    await p.keyboard.press("Escape");
    await p.mouse.up();
    return {
      before,
      after: await p.evaluate(
        () => evaluation.dock.layout.floating.find((w) => w.id === "a").width,
      ),
    };
  });
  await probe("resize listener continues after window blur", async (p) => {
    const h = p
      .getByRole("dialog", { name: "A", exact: true })
      .locator(".handle-se");
    const b = await h.boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.mouse.move(b.x + b.width / 2 + 20, b.y + b.height / 2);
    const beforeBlur = await p.evaluate(
      () => evaluation.dock.layout.floating.find((w) => w.id === "a").width,
    );
    await p.evaluate(() => window.dispatchEvent(new Event("blur")));
    await p.mouse.move(b.x + b.width / 2 + 70, b.y + b.height / 2);
    await p.mouse.up();
    return {
      beforeBlur,
      afterBlur: await p.evaluate(
        () => evaluation.dock.layout.floating.find((w) => w.id === "a").width,
      ),
    };
  });
  await probe("keyboard focus does not raise a floating pane", async (p) => {
    await p.evaluate(() => evaluation.dock.focus("d"));
    await input(p).focus();
    return {
      focused: await input(p).evaluate((el) => el === document.activeElement),
      order: await p.evaluate(() =>
        evaluation.dock.layout.floating.map((w) => w.id),
      ),
    };
  });
  await probe("unrelated pointerup commits titlebar drag", async (p) => {
    const grip = p
      .getByRole("dialog", { name: "A", exact: true })
      .locator(".titlebar");
    const b = await grip.boundingBox();
    const before = await p.evaluate(
      () => evaluation.dock.layout.floating.find((w) => w.id === "a").x,
    );
    await p.mouse.move(b.x + 30, b.y + 12);
    await p.mouse.down();
    await p.mouse.move(b.x + 70, b.y + 16);
    await expect(p.locator(".drag-ghost")).toBeAttached();
    await p.evaluate(() =>
      window.dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 999, bubbles: true }),
      ),
    );
    const after = await p.evaluate(
      () =>
        evaluation.dock.layout.floating.find((w) => w.id === "a")?.x ?? null,
    );
    const ghost = await p.locator(".drag-ghost").count();
    await p.mouse.up();
    return { before, after, ghostAfterUnrelatedPointerUp: ghost };
  });
  await probe(
    "host shrink leaves an existing floating pane outside the clipped host",
    async (p) => {
      await p.locator(".host").evaluate((el) => (el.style.width = "400px"));
      await expect
        .poll(
          async () => (await p.locator("[data-dock-host]").boundingBox()).width,
        )
        .toBeLessThan(420);
      const host = await p.locator("[data-dock-host]").boundingBox(),
        pane = await p
          .getByRole("dialog", { name: "D", exact: true })
          .boundingBox();
      return {
        hostRight: host.x + host.width,
        paneLeft: pane.x,
        reachable: pane.x < host.x + host.width,
        savedX: await p.evaluate(
          () => evaluation.dock.layout.floating.find((w) => w.id === "d").x,
        ),
      };
    },
  );
  await probe(
    "hydrate validates shape but permits invalid geometry and duplicate panel IDs",
    async (p) => {
      return await p.evaluate(async () => {
        const { createDockState } =
          await import("/banto/packages/dock-svelte/src/state.svelte.ts");
        const d = createDockState();
        d.hydrate(
          '{"version":2,"floating":[{"id":"a","title":"A","x":1e999,"y":0,"width":-1,"height":0,"open":true},{"id":"a","title":"duplicate","x":0,"y":0,"width":320,"height":280,"open":true}],"docked":null}',
        );
        return {
          acceptedCount: d.layout.floating.length,
          ids: d.layout.floating.map((w) => w.id),
          finiteX: Number.isFinite(d.layout.floating[0]?.x),
          width: d.layout.floating[0]?.width,
          height: d.layout.floating[0]?.height,
        };
      });
    },
  );
} finally {
  await browser.close();
  await writeFile("__RESULTS_FILE__", JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
}
