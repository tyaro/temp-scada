import { test, expect } from "@playwright/test";
import sample from "../examples/state-color.project.json" with { type: "json" };
import fixtures from "../examples/read-slot-view-cases.json" with { type: "json" };
import { chooseTheme } from "./helpers/designer";

for (const theme of ["light", "dark"] as const)
  test(`typed slot publications update one mounted main, embedded and popup view in ${theme}`, async ({
    page,
  }) => {
    await page.goto("/");
    await chooseTheme(page, theme);
    const results = await page.evaluate(
      async ({ sample, fixtures }) => {
        const sveltePath = "/node_modules/.vite/deps/svelte.js",
          reactivePath = "/node_modules/.vite/deps/svelte_reactivity.js";
        const sessionPath = "/src/lib/read-slot-session.ts",
          rendererPath = "/src/lib/Renderer.svelte",
          paintingPath = "/src/lib/ScreenPainting.svelte",
          projectPath = "/src/lib/project.ts",
          statusPath = "/src/lib/designer/SlotReadStatus.svelte";
        const { mount, unmount, tick } = await import(sveltePath);
        const { createSubscriber } = await import(reactivePath);
        const { createReadSlotSession, equipmentReadContext } = await import(
          sessionPath
        );
        const { parseProject } = await import(projectPath);
        const { default: SlotReadStatus } = await import(statusPath);
        const detailsPath = "/src/lib/designer/EquipmentReadDetails.svelte";
        const { default: EquipmentReadDetails } = await import(detailsPath);
        const { default: Renderer } = await import(rendererPath),
          { default: ScreenPainting } = await import(paintingPath);
        // Dynamic bool text colors must win even when a placement forces monochrome.
        (sample.symbols[0].objects[5].shape as any).boolColors = {
          trueColor: "#16a34a",
          falseColor: "#64748b",
          unknownColor: "#d97706",
        };
        (sample.symbols[0].objects[5] as any).colorAlpha = 0.4;
        (sample.symbols[0].objects[5] as any).opacity = 0.5;
        (sample.symbols[0].objects[0] as any).opacity = 0.5;
        (sample.symbols[0].objects[0] as any).colorAlpha = 0.5;
        sample.screens[0].objects[0].shape.colorMode = "monochrome";
        sample.screens[0].objects[0].fill = "#ff00ff";
        for (const equipment of sample.equipment) equipment.bindings = [];
        sample.equipment[0].bindings = [
          { slotName: "running", externalName: "Demo.Value" },
          { slotName: "current", externalName: "Demo.Number" },
        ];
        sample.equipment[1].bindings = [
          { slotName: "running", externalName: "Demo.Other" },
        ];
        const source = sample.screens[0];
        const direct = structuredClone(source.objects[0]);
        direct.id = "0199f600-0000-7000-8000-000000000201";
        direct.x = 0;
        direct.y = 0;
        sample.screens.push({
          id: "0199f600-0000-7000-8000-000000000200",
          name: "読取Host",
          width: 960,
          height: 900,
          background: "#ffffff",
          folders: [],
          groups: [],
          objects: [
            direct,
            {
              id: "0199f600-0000-7000-8000-000000000202",
              order: 1,
              x: 0,
              y: 200,
              width: 960,
              height: 540,
              rotation: 0,
              shape: {
                type: "screenView",
                screenId: source.id,
                fit: "contain",
              },
            },
          ],
        } as any);
        let project = parseProject(JSON.stringify(sample));
        const session = createReadSlotSession(project);
        let frame = session.frame,
          context = equipmentReadContext(project, frame),
          invalidate = () => {};
        const track = createSubscriber((update: () => void) => {
          invalidate = update;
          return () => {
            invalidate = () => {};
          };
        });
        const target = document.createElement("div");
        target.style.cssText =
          "position:fixed;left:0;top:0;width:1280px;height:900px;z-index:9999;background:white;pointer-events:none";
        const main = document.createElement("div"),
          popup = document.createElement("div");
        main.style.cssText = "width:960px;height:700px";
        popup.style.cssText = "width:960px;height:200px";
        target.append(main, popup);
        document.body.append(target);
        const props = {
          get screen() {
            track();
            return project.screens[1];
          },
          get screens() {
            track();
            return project.screens;
          },
          get symbols() {
            track();
            return project.symbols;
          },
          get equipmentContext() {
            track();
            return context;
          },
        };
        const mainStatus = document.createElement("div"),
          popupStatus = document.createElement("div");
        target.append(mainStatus, popupStatus);
        const detailTargets = [
          document.createElement("div"),
          document.createElement("div"),
        ];
        target.append(...detailTargets);
        const apps = [
          ...detailTargets.map((target, index) =>
            mount(EquipmentReadDetails, {
              target,
              props: {
                equipmentId: project.equipment![index].id,
                get equipmentContext() {
                  track();
                  return context;
                },
              },
            }),
          ),
          mount(SlotReadStatus, { target: mainStatus, props }),
          mount(SlotReadStatus, {
            target: popupStatus,
            props: {
              get screens() {
                track();
                return project.screens;
              },
              get symbols() {
                track();
                return project.symbols;
              },
              get equipmentContext() {
                track();
                return context;
              },
              get screen() {
                track();
                return project.screens[0];
              },
            },
          }),
          mount(Renderer, { target: main, props }),
          mount(ScreenPainting, {
            target: popup,
            props: {
              ...props,
              get screen() {
                track();
                return project.screens[0];
              },
              get equipmentContext() {
                track();
                return context;
              },
            },
          }),
        ];
        async function flush() {
          await tick();
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        }
        const snapshots: any[] = [];
        const roots = () => [
          main.querySelector(`[data-object-id="${direct.id}"]`)!,
          main.querySelector(
            `[data-source-object-id="${source.objects[0].id}"]`,
          )!,
          popup.querySelector(
            `[data-projected-object-id="${source.objects[0].id}"]`,
          )!,
        ];
        async function publish(name: string, nextFrame: any = frame) {
          frame = nextFrame;
          context = equipmentReadContext(project, frame);
          invalidate();
          await flush();
          snapshots.push({
            name,
            details: detailTargets.map((root) => ({
              state: root
                .querySelector('[data-equipment-slot="running"]')
                ?.getAttribute("data-slot-state"),
              value: root.querySelector(
                '[data-equipment-slot="running"] .value',
              )?.textContent,
              origin: root.querySelector(
                '[data-equipment-slot="running"] .origin',
              )?.textContent,
            })),
            paints: roots().map((root) => {
              const line = root.querySelector(
                `[data-symbol-child-id="${sample.symbols[0].objects[0].id}"]`,
              )!;
              const box = root.querySelector(
                `[data-symbol-child-id="${sample.symbols[0].objects[7].id}"]`,
              )!;
              return {
                line: line.querySelector("polyline")?.getAttribute("stroke"),
                arrow: line.querySelector("polygon")?.getAttribute("fill"),
                lineOpacity: line.getAttribute("opacity"),
                fill: box.querySelector("rect")?.getAttribute("fill"),
                stroke: box.querySelector("rect")?.getAttribute("stroke"),
                fillAlpha: box
                  .querySelector("rect")
                  ?.getAttribute("fill-opacity"),
                opacity: box.getAttribute("opacity"),
              };
            }),
            secondary: [
              main.querySelector(
                `[data-source-object-id="${source.objects[2].id}"]`,
              ),
              popup.querySelector(
                `[data-projected-object-id="${source.objects[2].id}"]`,
              ),
            ].map((root) =>
              root?.querySelector("polyline")?.getAttribute("stroke"),
            ),
            statuses: [mainStatus, popupStatus].map((root) => ({
              summary: root.querySelector("summary")?.textContent,
              open: root.querySelector("details")?.open,
              rows: [
                ...root.querySelectorAll<HTMLElement>("[data-slot-status-key]"),
              ].map((row) => ({
                state: row.dataset.slotState,
                text: row.textContent,
                simulated: row.dataset.slotSimulated,
              })),
            })),
            views: roots().map((root) =>
              [...root.querySelectorAll<SVGElement>("[data-tag-state]")].map(
                (node) => ({
                  state: node.dataset.tagState,
                  text: node.querySelector("[data-text-content]")?.textContent,
                  color: node
                    .querySelector("[data-text-content]")
                    ?.getAttribute("fill"),
                  source: node.getAttribute("data-tag-source"),
                  mode: node.getAttribute("data-collection-mode"),
                  time: node.getAttribute("data-source-timestamp-ms"),
                  description: node.getAttribute("aria-label"),
                  reason: node.getAttribute("data-tag-reason"),
                  opacity: node.closest("g")?.getAttribute("opacity"),
                }),
              ),
            ),
          });
        }
        function good() {
          const view = structuredClone(fixtures[0].view);
          const number = structuredClone(fixtures[2].view.slots[0]);
          number.externalName = "Demo.Number";
          view.slots.push(number as any);
          const other = structuredClone(view.slots[0]);
          other.key.equipmentId = sample.equipment[1].id;
          other.externalName = "Demo.Other";
          (other.reading as any).value.value = true;
          view.slots.push(other);
          return view;
        }
        try {
          await document.fonts.ready;
          await flush();
          mainStatus.querySelector("summary")!.click();
          popupStatus.querySelector("summary")!.click();
          await flush();
          await publish("pending");
          await publish(
            "good",
            session.receive(session.generation, good()).frame,
          );
          const trueValue = good();
          (trueValue.slots[0].reading as any).value.value = true;
          await publish(
            "true",
            session.receive(session.generation, trueValue).frame,
          );
          const invalidValue = good();
          invalidValue.slots[0].reading = {
            state: "invalid",
            reason: "disabled",
          } as any;
          invalidValue.slots[0].provenance = null;
          await publish(
            "invalid-value",
            session.receive(session.generation, invalidValue).frame,
          );
          await publish(
            "recovered",
            session.receive(session.generation, good()).frame,
          );
          const simulated = good();
          for (const row of simulated.slots)
            row.provenance!.valueSource = "simulation";
          await publish(
            "simulation",
            session.receive(session.generation, simulated).frame,
          );
          const stale = structuredClone(simulated);
          for (const row of stale.slots)
            row.reading = {
              state: "resolved",
              quality: "stale",
              value: null,
            } as any;
          await publish(
            "stale",
            session.receive(session.generation, stale).frame,
          );
          const bad = good();
          for (const row of bad.slots)
            row.reading = {
              state: "resolved",
              quality: "bad",
              value: null,
            } as any;
          await publish("bad", session.receive(session.generation, bad).frame);
          await publish(
            "good-again",
            session.receive(session.generation, good()).frame,
          );
          const stopped = good();
          stopped.connection = "reconnecting";
          stopped.metadataReady = false;
          for (const row of stopped.slots) {
            row.reading = { state: "disconnected" } as any;
            row.provenance = null;
          }
          await publish(
            "disconnected",
            session.receive(session.generation, stopped).frame,
          );
          await publish(
            "good-before-invalid",
            session.receive(session.generation, good()).frame,
          );
          const duplicate = good();
          duplicate.slots.push(structuredClone(duplicate.slots[0]));
          await publish(
            "invalid",
            session.receive(session.generation, duplicate).frame,
          );
          for (const screen of project.screens)
            screen.objects = screen.objects.map((object: any) =>
              object.shape.type === "symbol"
                ? {
                    ...object,
                    shape: { ...object.shape, colorMode: "definition" },
                  }
                : object,
            );
          project = parseProject(JSON.stringify(project));
          session.reset(project);
          await publish(
            "definition-color",
            session.receive(session.generation, good()).frame,
          );
          const token = session.generation;
          await publish(
            "good-before-reset",
            session.receive(token, good()).frame,
          );
          await publish("reset", session.reset(project).frame);
          await publish(
            "new-generation",
            session.receive(session.generation, good()).frame,
          );
          await publish(
            "old-token-ignored",
            session.receive(token, duplicate).frame,
          );
          project = parseProject(JSON.stringify(project));
          await publish("different-file-same-identity");
          await publish("replacement-reset", session.reset(project).frame);
          return snapshots;
        } finally {
          for (const app of apps) await unmount(app);
          target.remove();
        }
      },
      { sample: structuredClone(sample), fixtures: structuredClone(fixtures) },
    );
    for (const snapshot of results) {
      expect(snapshot.statuses.map((status: any) => status.open)).toEqual([
        true,
        true,
      ]);
      expect(
        snapshot.statuses.map((status: any) => status.rows.length),
      ).toEqual([8, 6]);
    }
    const goodSummary = results.find(
      (snapshot: any) => snapshot.name === "good",
    )!.statuses;
    expect(goodSummary[0].summary).toContain("表示参照 8件");
    expect(goodSummary[0].summary).toContain("取得不能 3件");
    const simSummary = results.find(
      (snapshot: any) => snapshot.name === "simulation",
    )!.statuses;
    expect(simSummary[0].summary).toContain("SIM 5件");
    expect(simSummary[1].summary).toContain("SIM 3件");
    const staleSummary = results.find(
      (snapshot: any) => snapshot.name === "stale",
    )!.statuses;
    expect(staleSummary[0].summary).toContain("取得不能 8件");
    expect(staleSummary[0].summary).toContain("SIM 5件");
    for (const name of [
      "disconnected",
      "invalid",
      "reset",
      "different-file-same-identity",
      "replacement-reset",
    ]) {
      const statuses = results.find(
        (snapshot: any) => snapshot.name === name,
      )!.statuses;
      expect(statuses[0].summary).toContain("取得不能 8件");
      for (const status of statuses) {
        expect(status.summary).toContain("SIM 0件");
        for (const row of status.rows) {
          expect(row.text).not.toContain("source real");
          expect(row.text).not.toContain("source simulation");
        }
      }
    }
    const goodNames = [
      "good",
      "true",
      "recovered",
      "simulation",
      "good-again",
      "good-before-invalid",
      "good-before-reset",
      "definition-color",
      "new-generation",
      "old-token-ignored",
    ];
    const definitionStart = results.findIndex(
      (snapshot: any) => snapshot.name === "definition-color",
    );
    for (const [index, snapshot] of results.entries()) {
      const color =
        snapshot.name === "true"
          ? "#16a34a"
          : goodNames.includes(snapshot.name)
            ? "#64748b"
            : "#d97706";
      for (const paint of snapshot.paints) {
        expect(paint.line).toBe(color);
        expect(paint.arrow).toBe(color);
        expect(paint.fill).toBe(color);
        expect(paint.stroke, `${snapshot.name} stroke`).toBe(
          index >= definitionStart ? "#112233" : "#ff00ff",
        );
        expect(paint.lineOpacity).toBe("0.25");
        expect(paint.opacity).toBe("0.5");
        expect(paint.fillAlpha).toBe("0.4");
      }
      const goodPrimary = goodNames.includes(snapshot.name);
      const goodSecondary = goodPrimary || snapshot.name === "invalid-value";
      expect(snapshot.details[0].state).toBe(
        goodPrimary
          ? "good"
          : ["invalid-value", "invalid"].includes(snapshot.name)
            ? "invalid"
            : ["stale", "bad"].includes(snapshot.name)
              ? snapshot.name
              : "disconnected",
      );
      expect(snapshot.details[1].state).toBe(
        goodSecondary
          ? "good"
          : snapshot.name === "invalid"
            ? "invalid"
            : ["stale", "bad"].includes(snapshot.name)
              ? snapshot.name
              : "disconnected",
      );
      if (goodPrimary)
        expect(snapshot.details[0].value).toContain(
          snapshot.name === "true" ? "true" : "false",
        );
      if (goodSecondary) expect(snapshot.details[1].value).toContain("true");
      if (snapshot.name === "simulation" || snapshot.name === "stale")
        expect(snapshot.details[0].value).toContain("SIM");
      if (
        [
          "disconnected",
          "invalid",
          "reset",
          "different-file-same-identity",
          "replacement-reset",
        ].includes(snapshot.name)
      ) {
        for (const detail of snapshot.details)
          expect(detail.origin).toBeUndefined();
      }
      expect(snapshot.secondary).toEqual(
        Array(2).fill(
          goodNames.includes(snapshot.name) || snapshot.name === "invalid-value"
            ? "#16a34a"
            : "#d97706",
        ),
      );
    }
    const byName = (name: string) =>
      results.find((item: any) => item.name === name)!.views;
    for (const name of [
      "good",
      "good-again",
      "recovered",
      "definition-color",
      "good-before-invalid",
      "good-before-reset",
      "new-generation",
      "old-token-ignored",
    ])
      for (const view of byName(name)) {
        expect(view.map((row: any) => row.text)).toEqual(["false", "0"]);
        expect(view[0].color).toBe("#64748b");
        expect(view.map((row: any) => row.state)).toEqual(["good", "good"]);
        expect(view.map((row: any) => row.source)).toEqual(["real", "real"]);
        expect(view.map((row: any) => row.reason)).toEqual([null, null]);
        expect(view[0].description).not.toContain("disabled");
      }
    for (const snapshot of results)
      for (const view of snapshot.views) expect(view[0].opacity).toBe("0.2");
    for (const view of byName("true")) {
      expect(view[0].text).toBe("true");
      expect(view[0].color).toBe("#16a34a");
    }
    for (const view of byName("invalid-value")) {
      expect(view[0].color).toBe("#d97706");
      expect(view[0].text).toBe("-- · 値が不正");
      expect(view[0].reason).toBe("disabled");
      expect(view[0].description).toContain("値が不正 · disabled");
      expect(view[0].source).toBeNull();
      expect(view[1].text).toBe("0");
    }
    for (const view of byName("simulation")) {
      expect(view.map((row: any) => row.text)).toEqual([
        "SIM · false",
        "SIM · 0",
      ]);
      expect(view[0].color).toBe("#64748b");
      expect(view[0].description).toContain("source simulation");
      expect(view[0].mode).toBe("configured");
      expect(view[0].time).toBe("1000");
    }
    for (const name of ["stale", "bad"])
      for (const view of byName(name)) {
        expect(view[0].color).toBe("#d97706");
        expect(view.map((row: any) => row.state)).toEqual([name, name]);
        for (const row of view)
          expect(row.text).toContain(
            `-- · ${name === "stale" ? "Stale" : "Bad"}`,
          );
      }
    for (const name of [
      "pending",
      "disconnected",
      "invalid",
      "reset",
      "different-file-same-identity",
      "replacement-reset",
    ])
      for (const view of byName(name)) {
        expect(view.map((row: any) => row.state)).toEqual([
          name === "invalid" ? "invalid" : "disconnected",
          name === "invalid" ? "invalid" : "disconnected",
        ]);
        expect(view[0].color).toBe("#d97706");
        for (const row of view) {
          expect(row.text).toContain("-- ·");
          expect(row.source).toBeNull();
          expect(row.time).toBeNull();
          expect(row.description).not.toContain("source real");
        }
      }
  });
