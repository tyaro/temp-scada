import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetStore } from "../../image-assets";
import type { EditCommand } from "../../editor";
import type { Project } from "../../project";
import {
  createClipboardController,
  type ClipboardHost,
} from "./clipboard.svelte";

/** OSのクリップボードの読取りを1件ずつ手で終わらせる（実行中に次の操作を試すため）。 */
let reads: { resolve: (text: string) => void; reject: (e: Error) => void }[] =
  [];
beforeEach(() => {
  reads = [];
  vi.stubGlobal("navigator", {
    clipboard: {
      readText: () =>
        new Promise<string>((resolve, reject) =>
          reads.push({ resolve, reject }),
        ),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * vitest（node）では `$effect` が動かないので、画面・モードの変化による失効
 * （TARGETのinvalidate）と破棄はe2eで確かめる。ここでは実行中のbusy、下書きの
 * 確定待ちでの先送り、失敗時の後始末だけを試す。
 */
function setup() {
  const owner = {
    generation: 1,
    screenId: "main",
    definitionId: undefined,
    mode: "edit" as "edit" | "preview",
    busy: false,
    replacing: false,
  };
  const edits: EditCommand[] = [];
  const reports: [string, string][] = [];
  const gate = { allow: true, held: [] as (() => void)[] };
  const draft = { pending: false, dirty: false };
  const project = { manifest: { projectRevision: 1 } } as unknown as Project;
  const host: ClipboardHost = {
    owner,
    project,
    objects: [],
    selectedIds: [],
    draft,
    viewport: {
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      size: { width: 100, height: 100 },
      scale: 1,
    },
    store: new AssetStore(),
    visibleCenter: () => ({ x: 50, y: 50 }),
    hiddenCanvasMutation: () => false,
    allow(run) {
      if (gate.allow) return true;
      gate.held.push(run);
      draft.pending = true;
      return false;
    },
    edit(command) {
      edits.push(command);
      return true;
    },
    stopPlacement() {},
    collectAssets() {},
    prepareImage: async () => {},
    report(kind, text) {
      reports.push([kind, text]);
    },
  };
  const controller = createClipboardController(host);
  return { controller, owner, project, edits, reports, gate, draft };
}

describe("clipboard controller の要求（Banto #436）", () => {
  it("実行中はbusyで、次の操作は受けない。終われば受ける", async () => {
    const { controller, reports } = setup();
    controller.action("paste");
    await settle();
    expect(controller.busy).toBe(true);
    expect(reads).toHaveLength(1);

    controller.action("paste");
    await settle();
    expect(reads).toHaveLength(1);

    reads[0].reject(new Error("拒否"));
    await settle();
    expect(controller.busy).toBe(false);
    expect(reports).toEqual([
      ["error", "クリップボード操作に失敗しました: 拒否"],
    ]);

    controller.action("paste");
    await settle();
    expect(reads).toHaveLength(2);
    expect(controller.busy).toBe(true);
  });

  it("下書きの確定待ちの間はbusyにせず、確定後に実行する", async () => {
    const { controller, gate, draft } = setup();
    gate.allow = false;
    controller.action("paste");
    await settle();
    expect(controller.busy).toBe(false);
    expect(reads).toHaveLength(0);
    expect(gate.held).toHaveLength(1);

    // 確定待ちの間の操作は入口で断る（先送りを上書きしない）。
    controller.action("paste");
    expect(gate.held).toHaveLength(1);

    draft.pending = false;
    gate.held[0]();
    await settle();
    expect(controller.busy).toBe(true);
    expect(reads).toHaveLength(1);
  });

  it("確定待ちのまま取り消された操作はbusyを残さない", async () => {
    const { controller, gate, draft } = setup();
    gate.allow = false;
    controller.action("paste");
    await settle();
    // 取り消し: 先送りした実行を捨てる。
    gate.held.length = 0;
    draft.pending = false;
    gate.allow = true;
    controller.action("paste");
    await settle();
    expect(reads).toHaveLength(1);
    expect(controller.busy).toBe(true);
  });

  it("読取りの間にProjectの版が変われば貼り付けない", async () => {
    const { controller, project, edits, reports } = setup();
    controller.action("paste");
    await settle();
    // 版の変化（ほかの編集）は対象の失効と別の条件として残る。
    project.manifest.projectRevision++;
    reads[0].resolve("text");
    await settle();
    expect(edits).toHaveLength(0);
    expect(controller.busy).toBe(false);
    expect(reports.filter(([kind]) => kind === "info")).toHaveLength(0);
  });
});
