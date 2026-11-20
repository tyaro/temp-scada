import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditCommand } from "../editor";

vi.mock("./forms/shape-paint", () => ({
  shapePaintCommand: vi.fn(() => ({ type: "shape-paint" })),
}));
vi.mock("./forms/selection-outline", async (actual) => ({
  ...(await actual<object>()),
  selectionOutlineCommand: vi.fn(() => ({ type: "selection-outline" })),
}));
vi.mock("./forms/project-form", async (actual) => ({
  ...(await actual<object>()),
  projectFormCommand: vi.fn(() => ({ type: "project" })),
}));
vi.mock("./forms/object-form", async (actual) => ({
  ...(await actual<object>()),
  objectFormCommand: vi.fn(() => ({ type: "object" })),
}));

import {
  COMMAND_FORM_KINDS,
  EDITOR_FORM_KINDS,
  FORM_ACKNOWLEDGES,
  FORM_COMMANDS,
  formCommand,
  type FormCommandContext,
} from "./form-commands";
import { shapePaintCommand } from "./forms/shape-paint";
import { selectionOutlineCommand } from "./forms/selection-outline";
import { projectFormCommand } from "./forms/project-form";
import { objectFormCommand } from "./forms/object-form";

// Node-only IO; keep the application's browser-only type environment.
interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { recursive: true }): string[];
}
const SRC = new URL("../../", import.meta.url);

async function editorFormKindsInSource(): Promise<Set<string>> {
  const { readFileSync, readdirSync } =
    await vi.importActual<NodeFs>("node:fs");
  const kinds = new Set<string>();
  const files = readdirSync(SRC, { recursive: true })
    .map((name) => name.replace(/\\/g, "/"))
    .filter((name) => /\.(svelte|ts)$/.test(name))
    .filter((name) => !name.endsWith(".test.ts"));
  for (const name of files) {
    const text = readFileSync(new URL(name, SRC), "utf8");
    // data-editor-form="kind" と data-editor-form={式}（式の中の文字列を全部）
    for (const match of text.matchAll(/data-editor-form="([^"]+)"/g))
      kinds.add(match[1]);
    for (const match of text.matchAll(/data-editor-form=\{([^}]*)\}/g))
      for (const literal of match[1].matchAll(/"([^"]+)"/g))
        kinds.add(literal[1]);
    // dataset.editorForm = "kind"（スクリプトで種類を付ける場合）
    for (const match of text.matchAll(/dataset\.editorForm\s*=\s*"([^"]+)"/g))
      kinds.add(match[1]);
  }
  return kinds;
}

function form(kind: string | undefined, dataset: Record<string, string> = {}) {
  return {
    isConnected: true,
    dataset: kind === undefined ? dataset : { editorForm: kind, ...dataset },
  } as unknown as HTMLFormElement;
}

const context = {
  project: { assets: [] },
  screen: { id: "screen-1", objects: [], readSlots: [] },
  activeDefinition: undefined,
  workspaceGeneration: 7,
  selectedIds: ["a", "b"],
  selected: { id: "a" },
  backgroundScreen: undefined,
  activeGroup: undefined,
  catalogSelection: { available: false },
} as unknown as FormCommandContext;

describe("form-commands の登録表", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ソースの data-editor-form がすべて種類の一覧にある", async () => {
    const used = await editorFormKindsInSource();
    expect(used.size).toBeGreaterThan(20);
    // 式で種類を作る ImageCrop の 2 種類も拾えていること
    expect(used).toContain("background-crop");
    expect(used).toContain("image-crop");
    const known = new Set<string>(EDITOR_FORM_KINDS);
    expect([...used].filter((kind) => !known.has(kind))).toEqual([]);
  });

  it("コマンドを作る種類は全部 handler を持ち、固有確定も同じ種類だけ", () => {
    expect(Object.keys(FORM_COMMANDS).sort()).toEqual(
      [...COMMAND_FORM_KINDS].sort(),
    );
    for (const kind of Object.keys(FORM_ACKNOWLEDGES))
      expect(COMMAND_FORM_KINDS).toContain(kind);
    expect(COMMAND_FORM_KINDS).not.toContain("binding-replacement");
  });

  it("種類に応じた adapter を呼ぶ", () => {
    const data = new FormData();
    const paint = form("shape-paint", { objectId: "a", targetKey: "k" });
    expect(formCommand(paint, context, data)).toEqual({ type: "shape-paint" });
    expect(shapePaintCommand).toHaveBeenCalledWith(
      { data, objectId: "a", targetKey: "k" },
      {
        generation: 7,
        screenId: "screen-1",
        definition: false,
        selected: { id: "a" },
      },
    );

    const outline = form("selection-outline", { objectIds: "a,b" });
    formCommand(outline, context, data);
    expect(selectionOutlineCommand).toHaveBeenCalledWith(
      { data, targetKey: undefined, objectIds: "a,b" },
      {
        generation: 7,
        screenId: "screen-1",
        definition: false,
        selectedIds: ["a", "b"],
      },
    );

    formCommand(form("project"), context, data);
    expect(projectFormCommand).toHaveBeenCalledWith(data);
    expect(objectFormCommand).not.toHaveBeenCalled();
  });

  it("種類の無い・未登録のフォームは通常配置のフォームとして解析する", () => {
    const data = new FormData();
    const expected = {
      readSlots: [],
      screenId: "screen-1",
      definition: false,
      selected: { id: "a" },
    };
    for (const target of [
      form(undefined),
      form("unknown-kind"),
      form("binding-replacement"),
    ]) {
      const command: EditCommand = formCommand(target, context, data);
      expect(command).toEqual({ type: "object" });
      expect(objectFormCommand).toHaveBeenLastCalledWith(data, expected);
    }
    expect(objectFormCommand).toHaveBeenCalledTimes(3);
    expect(shapePaintCommand).not.toHaveBeenCalled();
  });
});
