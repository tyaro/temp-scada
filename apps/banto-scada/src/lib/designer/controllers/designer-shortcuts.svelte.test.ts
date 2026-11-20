import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec } from "@banto/ui";
import {
  createDesignerShortcutsController,
  type DesignerShortcutsHost,
} from "./designer-shortcuts.svelte";

// node の環境なので DOM の型と document を偽物で置く（上流の入力欄・層の判定が使う）。
class FakeElement {
  closest(_selector: string): unknown {
    return null;
  }
}
class FakeHTMLElement extends FakeElement {
  isContentEditable = false;
}
class FakeInput extends FakeHTMLElement {
  type = "text";
  override closest(selector: string) {
    return selector.includes("input") ? this : null;
  }
}
class FakeTextArea extends FakeHTMLElement {}
class FakeSelect extends FakeHTMLElement {}

function keyEvent(
  key: string,
  init: Partial<{
    ctrlKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
    target: unknown;
  }> = {},
) {
  const event = {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    target: null as unknown,
    defaultPrevented: false,
    composedPath: () => [event.target],
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
    ...init,
  };
  return event;
}

function setup(state: Partial<{ busy: boolean }> = {}) {
  const calls: string[] = [];
  const host: DesignerShortcutsHost = {
    busy: state.busy ?? false,
    clipboardBusy: false,
    draftPending: false,
    replacement: false,
    helpOpen: false,
    canvasActive: true,
    positionPlacement: false,
    runtimeWindowOpen: false,
    dialogOpen: false,
    isTagPickerOpen: () => false,
    clipboardScope: () => true,
    hiddenCanvasMutation: () => false,
    renameFocused: () => void calls.push("rename"),
    removeSelection: () => void calls.push("remove"),
    save: () => void calls.push("save"),
    saveAs: () => void calls.push("saveAs"),
    stopPlacement: () => void calls.push("stopPlacement"),
    removeFolder: () => void calls.push("removeFolder"),
  };
  const shortcuts = createDesignerShortcutsController(host);
  const shared = (id: string, shortcut?: string): CommandSpec => ({
    id,
    title: id,
    shortcut,
    run: () => void calls.push(id),
  });
  const keys: Record<string, string> = {
    "help.open": "F1",
    "project.new": "Mod+N",
    "project.open": "Mod+O",
    "history.undo": "Mod+Z",
    "history.redo": "Mod+Y",
    "selection.all": "Mod+A",
  };
  shortcuts.register({ command: (id) => shared(id, keys[id]) });
  return { shortcuts, calls };
}

describe("designer shortcuts controller", () => {
  beforeEach(() => {
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    vi.stubGlobal("HTMLInputElement", FakeInput);
    vi.stubGlobal("HTMLTextAreaElement", FakeTextArea);
    vi.stubGlobal("HTMLSelectElement", FakeSelect);
    vi.stubGlobal("document", { querySelectorAll: () => [] });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("入力欄では Ctrl+Z・Ctrl+A を奪わず、F1 は入力欄でも効く", () => {
    const { shortcuts, calls } = setup();
    const target = new FakeInput();
    const undo = keyEvent("z", { ctrlKey: true, target });
    shortcuts.handle(undo as unknown as KeyboardEvent);
    const all = keyEvent("a", { ctrlKey: true, target });
    shortcuts.handle(all as unknown as KeyboardEvent);
    expect(undo.preventDefault).not.toHaveBeenCalled();
    expect(all.preventDefault).not.toHaveBeenCalled();
    expect(calls).toEqual([]);

    const help = keyEvent("F1", { target });
    shortcuts.handle(help as unknown as KeyboardEvent);
    expect(help.preventDefault).toHaveBeenCalled();
    expect(calls).toEqual(["help.open"]);
  });

  it("Ctrl+S は保存を呼び、ブラウザの既定を止める。押し続け・busy では呼ばない", () => {
    const { shortcuts, calls } = setup();
    const save = keyEvent("s", { ctrlKey: true, target: new FakeInput() });
    shortcuts.handle(save as unknown as KeyboardEvent);
    expect(save.preventDefault).toHaveBeenCalled();
    expect(calls).toEqual(["save"]);

    const saveAs = keyEvent("S", { ctrlKey: true, shiftKey: true });
    shortcuts.handle(saveAs as unknown as KeyboardEvent);
    expect(calls).toEqual(["save", "saveAs"]);

    const repeat = keyEvent("s", { ctrlKey: true, repeat: true });
    shortcuts.handle(repeat as unknown as KeyboardEvent);
    expect(repeat.preventDefault).toHaveBeenCalled();
    expect(calls).toEqual(["save", "saveAs"]);

    const busy = setup({ busy: true });
    const blocked = keyEvent("s", { ctrlKey: true });
    busy.shortcuts.handle(blocked as unknown as KeyboardEvent);
    expect(blocked.preventDefault).toHaveBeenCalled();
    expect(busy.calls).toEqual([]);
  });

  it("保護で断った予約キー（Ctrl+N・F2）もブラウザの既定を止め、ほかのキーは止めない", () => {
    const { shortcuts, calls } = setup();
    // 押し続けの Ctrl+N は dispatcher が断るが、新規ウィンドウは開かせない。
    const repeatNew = keyEvent("n", { ctrlKey: true, repeat: true });
    shortcuts.handle(repeatNew as unknown as KeyboardEvent);
    expect(repeatNew.preventDefault).toHaveBeenCalled();
    const rename = keyEvent("F2", { repeat: true });
    shortcuts.handle(rename as unknown as KeyboardEvent);
    expect(rename.preventDefault).toHaveBeenCalled();
    expect(calls).toEqual([]);

    // Shift+Ctrl+N は予約しない（ブラウザに任せる）。
    const shiftNew = keyEvent("N", { ctrlKey: true, shiftKey: true });
    shortcuts.handle(shiftNew as unknown as KeyboardEvent);
    expect(shiftNew.preventDefault).not.toHaveBeenCalled();
  });
});
