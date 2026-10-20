import { test, expect } from "@playwright/test";
import sample from "../examples/symbol-slots.project.json" with { type: "json" };
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
          projectPath = "/src/lib/project.ts";
        const { mount, unmount, tick } = await import(sveltePath);
        const { createSubscriber } = await import(reactivePath);
        const { createReadSlotSession, equipmentReadContext } = await import(
          sessionPath
        );
        const { parseProject } = await import(projectPath);
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
        sample.screens[0].objects[0].shape.colorMode = "monochrome";
        sample.screens[0].objects[0].fill = "#ff00ff";
        for (const equipment of sample.equipment) equipment.bindings = [];
        sample.equipment[0].bindings = [
          { slotName: "running", externalName: "Demo.Value" },
          { slotName: "current", externalName: "Demo.Number" },
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
        const apps = [
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
          return view;
        }
        try {
          await document.fonts.ready;
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
            for (const object of screen.objects)
              if (object.shape.type === "symbol")
                object.shape.colorMode = "definition";
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
