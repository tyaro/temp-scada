import { test, expect, type Locator, type Page } from "@playwright/test";
import sample from "../examples/alarm-value-color.project.json" with { type: "json" };
import { chooseTheme, mainCanvas } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

// 数値の警報の色の描画（#304 V2a）。仕様: docs/design/graphics/alarm-value-color.md
const PROJECT = sample.manifest.projectId;
const [TEMP, PUMP] = sample.alarms.definitions.map((item) => item.id);
const [LIGHT, DARK] = sample.screens;
const named = (screen: (typeof sample.screens)[number], name: string) =>
  screen.objects.find((object) => object.name === name)!.id;
const VALUE = "T-01 温度の値";
const FLOW = "P-01 流量の値";

/**
 * テスト用のエントリーだけに、モックの警報 feed と読取の源を渡す（製品には global の hook が無い）。
 */
async function mockEntry(page: Page) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const mount =
      /if \("__TAURI_INTERNALS__" in window\) \{[\s\S]*?\} else \{\s*mount\(App,\s*\{\s*target:\s*document\.getElementById\("app"\)\s*\}\);\s*\}/;
    expect(original).toMatch(mount);
    const injected = `
      const { createSubscriber } = await import("/node_modules/.vite/deps/svelte_reactivity.js");
      const { createMockAlarmFeed } = await import("/src/lib/mock-alarm-feed.ts");
      const { feed, control } = createMockAlarmFeed();
      window.__bantoAlarmMock = control;
      const trackSource = createSubscriber(() => () => {});
      const h = window.__readHarness = {};
      const source = {subscribe(project, begin) {
        h.delivery = begin();
        return () => {};
      }};
      mount(App, {target: document.getElementById("app"), props: {alarmFeed: feed, get readSource() {trackSource(); return source;}}});
    `;
    await route.fulfill({ response, body: original.replace(mount, injected) });
  });
}

async function openSample(page: Page, theme: string, project: unknown) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await mockEntry(page);
  await page.goto("/");
  await chooseTheme(page, theme);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await openProject(page, {
    name: "alarm-value-color.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
}

type Condition = { active: boolean; acked: boolean; unavailable?: string };
const NORMAL: Condition = { active: false, acked: true };
function condition({ active, acked, unavailable }: Condition) {
  return {
    active,
    occurrence: active || !acked ? "occ-1" : null,
    recurrence: 0,
    acked,
    timer: null,
    unavailable: unavailable ?? null,
    reportedUnavailable: unavailable ?? null,
    orderKey: null,
    occurredAtMs: null,
    observation: null,
  };
}
type State = Partial<Record<"hh" | "h" | "l" | "pump", Condition>>;
function snapshot(
  generation: number,
  state: State,
  { severity = true }: { severity?: boolean } = {},
) {
  const display = (limit: string, level: string) => ({
    name: "T-01 温度",
    message: "温度",
    ...(severity ? { severity: level } : {}),
    limitLabel: limit,
  });
  return {
    monitored: { projectId: PROJECT },
    applied: {
      projectId: PROJECT,
      projectRevision: 1,
      appliedAtMs: 1,
      displays: {
        [`${TEMP}:hh`]: display("HH", "high"),
        [`${TEMP}:h`]: display("H", "medium"),
        [`${TEMP}:l`]: display("L", "low"),
        [PUMP]: {
          name: "P-01 停止",
          message: "ポンプ 停止",
          ...(severity ? { severity: "medium" } : {}),
        },
      },
    },
    engine: {
      session: { id: `session-${generation}`, generation },
      seq: 1,
      unavailable: null,
      conditions: {
        [`${TEMP}:hh`]: condition(state.hh ?? NORMAL),
        [`${TEMP}:h`]: condition(state.h ?? NORMAL),
        [`${TEMP}:l`]: condition(state.l ?? NORMAL),
        [PUMP]: condition(state.pump ?? NORMAL),
      },
    },
    status: "running",
    pendingConditionChanges: false,
    pendingDisplayChanges: false,
    pendingUnknown: false,
    historyWriteFailure: null,
    rereadFailure: null,
  };
}
let generation = 0;
const setState = (page: Page, state: State, severity = true) =>
  page.evaluate(
    (value) => (window as any).__bantoAlarmMock.setSnapshot(value),
    snapshot(++generation, state, { severity }),
  );

/** 読取のモック。値の文字が出ることだけを確かめる。 */
function readings(sequence: number, temperature: number) {
  const reading = (value: number) => ({
    state: "resolved",
    quality: "good",
    numericValue: value,
  });
  const provenance = {
    catalogRevision: 1,
    runId: 1,
    collectionMode: "configured",
    valueSource: "real",
    sourceTimestampMs: 1000,
  };
  const head = {
    projectId: PROJECT,
    projectRevision: 1,
    connection: "live",
    lastError: null,
    metadataReady: true,
  };
  return {
    sequence,
    sdkGeneration: 1,
    text: {
      ...head,
      readings: {
        "Demo.Water.Tank01.Temperature": reading(temperature),
        "Demo.Water.Pump01.Flow": reading(3.5),
      },
      provenance: {
        "Demo.Water.Tank01.Temperature": provenance,
        "Demo.Water.Pump01.Flow": provenance,
      },
    },
    slots: { ...head, slots: [] },
  };
}

/** 画面直下の Text（編集・プレビュー・運転表示・ミニマップの Renderer）。 */
const direct = (root: Locator, name: string) =>
  root.locator(`[data-object-id="${named(LIGHT, name)}"] [data-alarm-tone]`);
/** 埋め込まれた暗い画面の中の Text。 */
const embedded = (root: Locator, name: string) =>
  root.locator(
    `[data-screen-view="${DARK.id}"] [data-source-object-id="${named(DARK, name)}"] [data-alarm-tone]`,
  );
/** 同じ condition を指す小札（画面直下）。 */
const badge = (root: Locator, limit: "HH" | "停止") =>
  root.locator(
    `[data-object-id="${LIGHT.objects[limit === "HH" ? 2 : 6].id}"] [data-alarm-badge]`,
  );

async function expectValue(
  value: Locator,
  tone: string,
  fill: string,
  underline?: string,
) {
  await expect(value).toHaveAttribute("data-alarm-tone", tone);
  await expect(value.locator("[data-text-content]")).toHaveAttribute(
    "fill",
    fill,
  );
  if (underline) {
    await expect(value).toHaveAttribute("data-alarm-underline", underline);
    await expect(value.locator("[data-alarm-underline-mark]")).toHaveCount(1);
  } else {
    await expect(value).not.toHaveAttribute("data-alarm-underline", /.*/);
    await expect(value.locator("[data-alarm-underline-mark]")).toHaveCount(0);
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`a value follows the badge on light and embedded dark screens in ${theme}`, async ({
    page,
  }) => {
    await openSample(page, theme, {
      ...sample,
      alarms: { ...sample.alarms, blinkUnacked: true },
    });
    const canvas = mainCanvas(page);
    const light = direct(canvas, VALUE);
    const dark = embedded(canvas, VALUE);
    await expect(light).toHaveCount(1);
    await expect(dark).toHaveCount(1);

    // Engine が無いあいだは不明の灰色（組は画面の背景ごと）。
    await expectValue(light, "unknown", "#6b7280");
    await expectValue(dark, "unknown", "#9ca3af");
    await expect(light).toHaveAttribute(
      "aria-label",
      /警報 T-01 温度: 不明（警報の Engine が動いていません）$/,
    );

    // 正常は配置の fill のまま。
    await setState(page, {});
    await expectValue(light, "normal", LIGHT.objects[1].fill!);
    await expectValue(dark, "normal", DARK.objects[1].fill!);
    await expect(light.locator("title")).toHaveText(/ · 警報 T-01 温度: 正常$/);
    await expect(badge(canvas, "HH")).toHaveAttribute(
      "data-alarm-state",
      "normal",
    );

    // HH 未確認（発生中）: 小札も同じ状態、文字は high の色、下線だけが点滅する。
    await setState(page, { hh: { active: true, acked: false } });
    await expect(badge(canvas, "HH")).toHaveAttribute(
      "data-alarm-state",
      "activeUnacked",
    );
    await expectValue(light, "high", "#dc2626", "high");
    await expectValue(dark, "high", "#f87171", "high");
    await expect(light).toHaveAttribute(
      "aria-label",
      /警報 T-01 温度: HH 未確認（発生中）$/,
    );
    const mark = light.locator("[data-alarm-underline-mark]");
    const text = light.locator("[data-text-content]");
    await expect(mark).toHaveAttribute("fill", "#dc2626");
    const animation = (target: Locator) =>
      target.evaluate((node) => getComputedStyle(node).animationName);
    await expect.poll(() => animation(mark)).not.toBe("none");
    // 点滅中も文字の色と不透明度は変わらない。
    for (let i = 0; i < 4; i += 1) {
      expect(
        await text.evaluate((node) => ({
          animation: getComputedStyle(node).animationName,
          opacity: getComputedStyle(node).opacity,
          fill: node.getAttribute("fill"),
          group: getComputedStyle(node.closest("[data-alarm-tone]")!).opacity,
        })),
      ).toEqual({
        animation: "none",
        opacity: "1",
        fill: "#dc2626",
        group: "1",
      });
      await page.waitForTimeout(260);
    }
    // 「動きを減らす」では止め、下線は出したまま。
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => animation(mark)).toBe("none");
    await expect(mark).toBeVisible();
    expect(await mark.evaluate((node) => getComputedStyle(node).opacity)).toBe(
      "1",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // 確認済み（発生中）: 色は残り、下線は消える。
    await setState(page, { hh: { active: true, acked: true } });
    await expect(badge(canvas, "HH")).toHaveAttribute(
      "data-alarm-state",
      "activeAcked",
    );
    await expectValue(light, "high", "#dc2626");
    await expectValue(dark, "high", "#f87171");

    // 復帰・未確認: 文字は配置の fill、下線は残る。
    await setState(page, { hh: { active: false, acked: false } });
    await expect(badge(canvas, "HH")).toHaveAttribute(
      "data-alarm-state",
      "returnedUnacked",
    );
    await expectValue(light, "normal", LIGHT.objects[1].fill!, "high");
    await expectValue(dark, "normal", DARK.objects[1].fill!, "high");
    await expect(light).toHaveAttribute(
      "aria-label",
      /警報 T-01 温度: HH 復帰・未確認$/,
    );

    // H と HH が重なれば優先の高い HH の色。
    await setState(page, {
      hh: { active: true, acked: true },
      h: { active: true, acked: false },
    });
    await expectValue(light, "high", "#dc2626", "medium");
    await expect(light).toHaveAttribute(
      "aria-label",
      /警報 T-01 温度: HH 発生中、H 未確認（発生中）$/,
    );

    // severity が表示情報に無いときは、小札と同じく high の色。
    await setState(page, { h: { active: true, acked: true } }, false);
    await expect(badge(canvas, "HH")).toHaveAttribute(
      "data-alarm-state",
      "normal",
    );
    await expectValue(light, "high", "#dc2626");

    // 別のタグ（流量）の Text が、ポンプ停止の bit の定義を指す。
    await setState(page, { pump: { active: true, acked: false } });
    await expect(badge(canvas, "停止")).toHaveAttribute(
      "data-alarm-state",
      "activeUnacked",
    );
    await expectValue(direct(canvas, FLOW), "medium", "#c2410c", "medium");
    await expectValue(embedded(canvas, FLOW), "medium", "#fb923c", "medium");
    await expectValue(light, "normal", LIGHT.objects[1].fill!);

    // 発生中に評価不能が重なっても発生中の色、評価不能だけなら灰色。
    await setState(page, {
      hh: { active: true, acked: true, unavailable: "stale" },
    });
    await expectValue(light, "high", "#dc2626");
    await expect(light).toHaveAttribute(
      "aria-label",
      /警報 T-01 温度: HH 発生中・評価不能$/,
    );
    await setState(page, {
      h: { active: false, acked: true, unavailable: "bad" },
    });
    await expectValue(light, "unknown", "#6b7280");
    await expectValue(dark, "unknown", "#9ca3af");
  });

  test(`the pair and the outline follow the screen background in ${theme}`, async ({
    page,
  }) => {
    const withBackground = (background: string) => {
      const project = structuredClone(sample);
      project.screens[1].background = background;
      return project;
    };
    const check = async (
      background: string,
      fill: string,
      outline: boolean,
    ) => {
      await openSample(page, theme, withBackground(background));
      await setState(page, { hh: { active: true, acked: false } });
      const value = embedded(mainCanvas(page), VALUE);
      await expectValue(value, "high", fill, "high");
      const text = value.locator("[data-text-content]");
      const mark = value.locator("[data-alarm-underline-mark]");
      if (outline) {
        await expect(value).toHaveAttribute("data-alarm-outline", "true");
        await expect(text).toHaveAttribute("stroke", "#000000");
        await expect(text).toHaveAttribute("paint-order", "stroke");
        // 太さは max(1, fontSize × 0.12)。下線にも同じ縁。
        await expect(text).toHaveAttribute("stroke-width", "2.88");
        await expect(mark).toHaveAttribute("stroke", "#000000");
        await expect(mark).toHaveAttribute("stroke-width", "2.88");
      } else {
        await expect(value).not.toHaveAttribute("data-alarm-outline", /.*/);
        await expect(text).not.toHaveAttribute("stroke", /.*/);
        await expect(mark).not.toHaveAttribute("stroke", /.*/);
      }
      // 画面直下（白）の組は埋込の背景に引きずられない。
      await expectValue(
        direct(mainCanvas(page), VALUE),
        "high",
        "#dc2626",
        "high",
      );
    };
    // 比 4.5 の境目の両側（high の暗い組）と中間色、明るい背景の埋込。
    await check("#343434", "#f87171", false);
    await check("#353535", "#f87171", true);
    await check("#969696", "#f87171", true);
    await check("#f7f7f7", "#dc2626", false);
  });

  test(`outlines and underlines stay inside small, overflowing and rotated Texts in ${theme}`, async ({
    page,
  }) => {
    const project = structuredClone(sample);
    project.screens[0].background = "#969696";
    await openSample(page, theme, project);
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await page.evaluate(
      (update) => (window as any).__readHarness.delivery.receive(update),
      readings(1, 85.25),
    );
    await setState(page, { hh: { active: true, acked: false } });
    const canvas = mainCanvas(page);
    await expect(
      direct(canvas, VALUE).locator("[data-text-content]"),
    ).toHaveText("85.3 ℃");
    const overflow = direct(canvas, "T-01 温度のはみ出す値");
    await expect(overflow).toHaveAttribute("data-text-layout", "overflow");
    await expect(overflow.locator("[data-text-content]")).toHaveText("###");
    for (const name of [
      "T-01 温度の小さい値",
      "T-01 温度のはみ出す値",
      "T-01 温度の回転した値",
      // 大きい文字の左・右揃え（縁の半分が揃えの余白 2 を超える）。#355 のレビュー。
      "T-01 温度の大きい左揃えの値",
      "T-01 温度の大きい右揃えの値",
    ]) {
      const value = direct(canvas, name);
      await expectValue(value, "high", "#f87171", "high");
      await expect(value).toHaveAttribute("data-alarm-outline", "true");
      const box = await value.evaluate((svg) => {
        const text = svg.querySelector<SVGTextElement>("[data-text-content]")!;
        const mark = svg.querySelector<SVGRectElement>(
          "[data-alarm-underline-mark]",
        )!;
        const ink = text.getBBox();
        const line = mark.getBBox();
        const stroke = Number(text.getAttribute("stroke-width"));
        return {
          baseline: Number(text.getAttribute("y")),
          width: Number(svg.getAttribute("width")),
          height: Number(svg.getAttribute("height")),
          ink: { x: ink.x, y: ink.y, w: ink.width, h: ink.height },
          line: { x: line.x, y: line.y, w: line.width, h: line.height },
          stroke,
        };
      });
      const half = box.stroke / 2;
      // 下線は文字の幅（### のときもその幅）で、縁を含めて枠の内側。
      expect(box.line.w).toBeCloseTo(box.ink.w, 0);
      expect(box.line.x).toBeCloseTo(box.ink.x, 0);
      expect(box.line.y + box.line.h + half).toBeLessThanOrEqual(
        box.height + 0.01,
      );
      expect(box.line.y).toBeGreaterThan(box.ink.y);
      // 下線は枠に押されて文字の上へ寄らない（baseline より下）。
      expect(box.line.y - half).toBeGreaterThanOrEqual(box.baseline - 0.01);
      // 下線の縁も横に切られない。
      expect(box.line.x - half).toBeGreaterThanOrEqual(-0.01);
      expect(box.line.x + box.line.w + half).toBeLessThanOrEqual(
        box.width + 0.01,
      );
      // 文字の箱（フォントの箱）は枠の内側。字形の上下はその中にあり、縁の半幅より広い余白がある。
      expect(box.ink.y).toBeGreaterThanOrEqual(-0.01);
      expect(box.ink.y + box.ink.h).toBeLessThanOrEqual(box.height + 0.01);
      // 文字の縁（文字の箱 + 縁の半分）が横に切られない。
      expect(box.ink.x - half).toBeGreaterThanOrEqual(-0.01);
      expect(box.ink.x + box.ink.w + half).toBeLessThanOrEqual(
        box.width + 0.01,
      );
      test.info().annotations.push({
        type: "clip",
        description: `${name}: ${JSON.stringify(box)}`,
      });
    }
    await page.screenshot({
      path: test.info().outputPath(`alarm-value-color-${theme}.png`),
    });
  });

  test(`preview, operator view and minimap use the same pair in ${theme}`, async ({
    page,
  }) => {
    await openSample(page, theme, {
      ...sample,
      operatorFrame: { startScreenId: LIGHT.id },
    });
    await setState(page, {
      hh: { active: true, acked: true },
      pump: { active: false, acked: false },
    });
    const expectAll = async (root: Locator) => {
      await expectValue(direct(root, VALUE), "high", "#dc2626");
      await expectValue(embedded(root, VALUE), "high", "#f87171");
      await expectValue(
        direct(root, FLOW),
        "normal",
        LIGHT.objects[5].fill!,
        "medium",
      );
      await expectValue(
        embedded(root, FLOW),
        "normal",
        DARK.objects[5].fill!,
        "medium",
      );
    };
    await expectAll(mainCanvas(page));
    await expectAll(page.locator('[aria-label="ミニマップ"]'));
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await expectAll(mainCanvas(page));
    await page.getByRole("button", { name: "運転表示", exact: true }).click();
    await expectAll(page.getByRole("region", { name: "運転表示" }));
  });
}
