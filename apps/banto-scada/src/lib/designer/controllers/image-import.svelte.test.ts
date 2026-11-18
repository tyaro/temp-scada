import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetStore } from "../../image-assets";
import type { EditCommand } from "../../editor";
import {
  createImageImportController,
  type ImageImportHost,
} from "./image-import.svelte";

const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVhEAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);
const file = (name: string) => new File([png], name, { type: "image/png" });

/** 画像のdecodeを1件ずつ手で終わらせる（読込の途中で状況を変えるため）。 */
let decodes: (() => void)[] = [];
beforeEach(() => {
  decodes = [];
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(
      () =>
        new Promise((resolve) =>
          decodes.push(() => resolve({ width: 1, height: 1, close() {} })),
        ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** decodeが待ちに入るまで進める（その前にsha256などのawaitがある）。 */
async function untilDecoding(count: number) {
  await vi.waitFor(() => expect(decodes.length).toBeGreaterThanOrEqual(count));
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * vitest（node）では svelte がサーバー向けにコンパイルされ `$effect` が動かない。
 * 対象の変化による失効（imageScope）と破棄はe2eで確かめ、ここでは読込どうしの失効と
 * 一時storeの寿命だけを試す。
 */
function setup() {
  const owner = {
    generation: 1,
    screenId: "main",
    mode: "edit" as "edit" | "preview",
    definition: false,
    busy: false,
    replacing: false,
  };
  const edits: EditCommand[] = [];
  const errors: string[] = [];
  const gate = { allow: true, held: [] as (() => void)[] };
  const store = new AssetStore();
  const host: ImageImportHost = {
    owner,
    selected: undefined,
    selectedIds: [],
    viewport: {
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      size: { width: 100, height: 100 },
    },
    store,
    assetByHash: () => undefined,
    background: () => undefined,
    chooseReplacement() {},
    choosePlacement() {},
    transition: (run) => run(),
    allow(run) {
      if (gate.allow) return true;
      gate.held.push(run);
      return false;
    },
    edit(command) {
      edits.push(command);
      return true;
    },
    stopPlacement() {},
    collectAssets() {},
    revealObject() {},
    report: (_kind, text) => errors.push(text),
  };
  const controller = createImageImportController(host);
  return { owner, edits, errors, gate, controller };
}

describe("画像取込の要求（createRequestOwner）", () => {
  it("新しい読込が古い読込を失効させ、古い読込の終わりは新しい読込のbusyを解かない", async () => {
    const { controller, edits } = setup();
    controller.importBackground(file("a.png"));
    await untilDecoding(1);
    controller.importBackground(file("b.png"));
    await untilDecoding(2);
    expect(controller.busy).toBe(true);

    decodes[0]();
    await settle();
    expect(edits).toHaveLength(0);
    expect(controller.busy).toBe(true);

    decodes[1]();
    // decodeの後にもawaitが続くので、CIの負荷で決まった回数の待ちでは足りない。
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    expect(edits.map((edit) => edit.type)).toEqual(["set-background-image"]);
  });

  it("入力の確定待ちで先送りした適用は、読込の終わった後も一時storeを使える", async () => {
    const { controller, gate, edits, errors } = setup();
    gate.allow = false;
    controller.importBackground(file("a.png"));
    await untilDecoding(1);
    decodes[0]();
    await vi.waitFor(() => expect(gate.held).toHaveLength(1));
    expect(controller.busy).toBe(false);

    gate.held[0]();
    expect(errors).toEqual([]);
    expect(edits.map((edit) => edit.type)).toEqual(["set-background-image"]);
  });
});
