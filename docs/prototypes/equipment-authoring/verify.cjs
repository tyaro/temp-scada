const { chromium } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const results = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  results.push(name);
};
(async () => {
  const server = require("node:http").createServer(async (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(await fs.readFile(__dirname + "/standalone.html"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      acceptDownloads: true,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("http://127.0.0.1:" + server.address().port);
    const state = () => page.evaluate(() => window.equipmentStudy.getState());
    const click = (id) => page.locator("#" + id).click();
    const apply = () => click("apply");
    const feature = (s) => page.locator(`[data-feature="${s}"]`).check();
    const tag = async (s, name) => {
      await page.locator(`[data-slot="${s}"]`).click();
      await page.locator(`[data-tag="${name}"]`).click();
    };
    check(
      "初期機器は運転だけ・未割付・配置なし",
      (await state()).model.equipment[0].bindings.running === null &&
        (await state()).model.placements.length === 0,
    );
    await click("place");
    check(
      "未割付機器を配置できる",
      (await state()).model.placements.length === 1 &&
        (await page.locator(".placement").innerText()).includes("未割付"),
    );
    await tag("running", "PLC01.FAN101.Run");
    check(
      "適用前は保存済み割付が変わらない",
      (await state()).model.equipment[0].bindings.running === null,
    );
    await apply();
    check(
      "模擬運転を表示する",
      (await page.locator(".placement").innerText()).includes("運転"),
    );
    await page.locator('[data-page="detail"]').click();
    await click("place");
    let s = await state();
    check(
      "2画面で同じ機器IDを参照",
      s.model.placements.length === 2 &&
        new Set(s.model.placements.map((p) => p.equipmentId)).size === 1,
    );
    await page.locator("#name").fill("誘引送風機・共通名称");
    await apply();
    check(
      "機器名変更が詳細へ反映",
      (await page.locator(".placement").innerText()).includes("共通名称"),
    );
    await feature("current");
    await tag("current", "PLC01.FAN101.Current");
    await apply();
    s = await state();
    check(
      "電流追加は配置形式を変えない",
      s.model.placements.every((p) => p.view === "symbol"),
    );
    await page.locator("#view").selectOption("meter");
    check(
      "電流表示へ明示切替",
      (await page.locator(".reading").innerText()).includes("12.4 A"),
    );
    await page.locator("#quality").selectOption("stale");
    check(
      "通信不明は運転や0に置換しない",
      (await page.locator(".placement").innerText()).includes("通信不明") &&
        !(await page.locator(".reading").innerText()).includes("0.0"),
    );
    await page.locator("#connection").selectOption("offline");
    check(
      "catalog未確認を品質不明と区別",
      (await page.locator(".reading").innerText()).includes("未確認"),
    );
    await page.locator("#connection").selectOption("online");
    await page.locator("#quality").selectOption("running");
    await page.locator('[data-slot="current"]').click();
    check(
      "単位不一致候補を拒否",
      await page.locator('[data-tag="PLC01.Duct.Pressure"]').isDisabled(),
    );
    check(
      "型不一致候補を拒否",
      await page.locator('[data-tag="PLC01.FAN101.Run"]').isDisabled(),
    );
    await page.locator("#tag-search").fill("FAN102.Current");
    check("catalog検索", (await page.locator(".candidate").count()) === 1);
    await click("close-picker");
    const beforeDrag = (await state()).model.placements.find(
      (p) => p.page === "detail",
    );
    let box = await page.locator(".placement").boundingBox();
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 70);
    await page.mouse.up();
    s = await state();
    check(
      "マウス移動は選択画面だけを変える",
      s.model.placements.find((p) => p.id === beforeDrag.id).x ===
        beforeDrag.x + 50 &&
        s.model.placements.find((p) => p.page === "overview").x === 60,
    );
    const cancelBefore = (await state()).model.placements.find(
      (p) => p.id === beforeDrag.id,
    );
    box = await page.locator(".placement").boundingBox();
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 80);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    check(
      "Escでドラッグ取消",
      (await state()).model.placements.find((p) => p.id === beforeDrag.id).x ===
        cancelBefore.x,
    );
    await page.locator(".placement").focus();
    await page.keyboard.press("ArrowRight");
    check(
      "矢印キーで位置調整",
      (await state()).model.placements.find((p) => p.id === beforeDrag.id).x ===
        cancelBefore.x + 1,
    );
    await page.locator('[data-page="overview"]').click();
    check(
      "別画面の名前共有と形式独立",
      (await page.locator(".placement").innerText()).includes("共通名称") &&
        (await page.locator(".reading").count()) === 0,
    );
    await page.locator("#name").fill("未適用の名称");
    await page.locator('[data-page="detail"]').click();
    check(
      "画面変更で未適用保護",
      (await page.locator("#guard").isVisible()) &&
        (await state()).page === "overview",
    );
    await click("stay");
    check(
      "編集継続で入力保持",
      (await page.locator("#name").inputValue()) === "未適用の名称",
    );
    await page.locator('[data-page="detail"]').click();
    await click("discard");
    check(
      "破棄して移動は旧設定を保持",
      (await state()).model.equipment[0].name === "誘引送風機・共通名称" &&
        (await state()).page === "detail",
    );
    await page.locator(".placement").click();
    await click("copy");
    check(
      "同機器表示の複製で台帳は増えない",
      (await state()).model.equipment.length === 1 &&
        (await state()).model.placements.length === 3,
    );
    await click("clone");
    s = await state();
    check(
      "別機器複製は全信号が未割付",
      s.isNew &&
        s.draft.code === "FAN-102" &&
        Object.values(s.draft.bindings).every((v) => v === null),
    );
    check("複製は適用まで台帳へ追加しない", s.model.equipment.length === 1);
    await apply();
    s = await state();
    check(
      "別機器の登録は別ID",
      s.model.equipment.length === 2 &&
        s.model.equipment[0].id !== s.model.equipment[1].id,
    );
    await click("place");
    check(
      "別機器配置は未割付を表示",
      (await page.locator(".placement.selected").innerText()).includes(
        "未割付",
      ),
    );
    await click("remove");
    check(
      "最後の配置削除で機器台帳を残す",
      (await state()).model.equipment.length === 2,
    );
    await click("undo");
    s = await state();
    check(
      "Undoで配置復元",
      s.model.placements.some((p) => p.equipmentId === s.selected),
    );
    await click("add");
    await page.locator("#code").fill("FAN-101");
    await page.locator("#name").fill("重複");
    await apply();
    check(
      "機器番号の重複を拒否",
      (await state()).model.equipment.length === 2 &&
        (await page.locator("#status").innerText()).includes("重複"),
    );
    await click("cancel");
    await click("add");
    await page.locator("#code").fill("FAN-103");
    await page.locator("#name").fill("信号なし冷却送風機");
    await apply();
    s = await state();
    check("信号なし登録", s.model.equipment.at(-1).features.length === 0);
    await feature("running");
    await apply();
    await click("cancel");
    check(
      "採用済み未割付を再表示",
      (await state()).draft.features.includes("running") &&
        (await state()).draft.bindings.running === null,
    );
    await page.locator('[data-equipment="fan-101"]').click();
    await page.locator('[data-feature="current"]').uncheck();
    check(
      "機能解除の影響を案内",
      (await page.locator("#impact").innerText()).includes(
        "解除する機能・割付：電流表示",
      ),
    );
    await click("cancel");
    check(
      "取消で割付を保持",
      (await state()).draft.bindings.current === "PLC01.FAN101.Current",
    );
    const downloadPromise = page.waitForEvent("download");
    await click("export");
    const download = await downloadPromise;
    const data = JSON.parse(await fs.readFile(await download.path(), "utf8"));
    check(
      "書出しは試作専用形式",
      data.format === "equipment-authoring-study-v1",
    );
    check(
      "実タグを配置に複写しない",
      data.placements.every((p) => !("bindings" in p)),
    );
    await page.locator('[data-page="detail"]').click();
    await page.locator("[data-placement]").first().focus();
    await page.keyboard.press("Enter");
    check(
      "Enterで配置を選択して機器を表示",
      (await state()).placementId ===
        (await page
          .locator("[data-placement]")
          .first()
          .getAttribute("data-placement")),
    );
    for (let i = 0; i < 23; i++) await page.keyboard.press("Shift+ArrowDown");
    await page.screenshot({
      path: __dirname + "/preview-1920x1080.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1536, height: 864 });
    check(
      "125%相当で横はみ出しなし",
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    check(
      "登録ペインがキャンバスを覆わない",
      await page.evaluate(
        () =>
          document.querySelector(".right").getBoundingClientRect().left >=
          document.querySelector(".workspace").getBoundingClientRect().right,
      ),
    );
    await page.screenshot({
      path: __dirname + "/preview-125-percent-equivalent.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 760, height: 900 });
    check(
      "狭い表示で横はみ出しなし",
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    check("ブラウザ例外なし", errors.length === 0);
    await fs.writeFile(
      __dirname + "/verification.json",
      JSON.stringify({ checks: results.length, results, errors }, null, 2),
    );
    console.log(`${results.length} checks passed`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
