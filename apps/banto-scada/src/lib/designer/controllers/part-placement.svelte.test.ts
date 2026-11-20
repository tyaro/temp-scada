import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditCommand } from "../../editor";
import { DEFAULT_FAVORITES, FAVORITES_LIMIT, favoriteKey } from "../favorites";
import type { PalettePart } from "../palette-drag";
import {
  createPartPlacementController,
  type PartPlacementHost,
} from "./part-placement.svelte";

const rect: PalettePart = { type: "basic", kind: "rectangle" };

/** `gate.allow` が false の間は、ゲートが入力の確定を待つ（action を保留する）。 */
function setup(initial: string[] = []) {
  const gate = { allow: true, held: [] as (() => void)[] };
  const edits: EditCommand[] = [];
  const saved: string[][] = [];
  const reports: string[] = [];
  const state = {
    screenId: "screen-1",
    generation: 0,
    mode: "edit" as "edit" | "preview",
    hand: true,
    focused: 0,
  };
  const host: PartPlacementHost = {
    projectId: "project-1",
    symbols: [],
    get screenId() {
      return state.screenId;
    },
    get generation() {
      return state.generation;
    },
    get mode() {
      return state.mode;
    },
    definition: false,
    busy: false,
    get draftPending() {
      return gate.held.length > 0;
    },
    replacing: false,
    transition(run) {
      if (gate.allow) run();
      else gate.held.push(run);
    },
    edit(command) {
      edits.push(command);
      return true;
    },
    visibleCenter: () => ({ x: 10, y: 20 }),
    setHand: (value) => (state.hand = value),
    focusCanvas: () => state.focused++,
    showPartsPanel: () => {},
    loadFavorites: () => [...initial],
    saveFavorites: async (keys) => void saved.push([...keys]),
    report: (_kind, text) => void reports.push(text),
  };
  const placement = createPartPlacementController(host);
  return { placement, gate, edits, saved, reports, state };
}

describe("部品の配置の controller", () => {
  // arm の後のフォーカスは tick 後に document.activeElement を読む。
  beforeEach(() => {
    vi.stubGlobal("Element", class {});
    vi.stubGlobal("document", { activeElement: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("お気に入りは上限で登録を断り、既定値に戻せる", () => {
    const keys = Array.from({ length: FAVORITES_LIMIT }, (_, i) => `k${i}`);
    const { placement, saved, reports } = setup(keys);
    expect(placement.isFavorite(rect)).toBe(false);
    placement.toggleFavorite(rect);
    expect(placement.favoriteKeys).toHaveLength(FAVORITES_LIMIT);
    expect(reports).toHaveLength(1);
    expect(saved).toEqual([]);

    placement.resetFavorites();
    expect(placement.favoriteKeys).toEqual(DEFAULT_FAVORITES);
    expect(saved.at(-1)).toEqual(DEFAULT_FAVORITES);

    const key = favoriteKey(rect, "project-1");
    const had = placement.favoriteKeys.includes(key);
    placement.toggleFavorite(rect);
    expect(placement.favoriteKeys.includes(key)).toBe(!had);
  });

  it("arm で連続配置に入り、stop で抜ける", () => {
    const { placement, state, edits } = setup();
    placement.armPart(rect);
    expect(placement.positionPlacement).toBe(true);
    expect(placement.armedPart).toEqual(rect);
    expect(placement.isArmed({ type: "basic", kind: "rectangle" })).toBe(true);
    expect(state.hand).toBe(false);

    // 置いた後も連続配置を続け、キャンバスへフォーカスを戻す。
    placement.placeArmed({ x: 1, y: 2 });
    expect(edits).toHaveLength(1);
    expect(placement.positionPlacement).toBe(true);
    expect(state.focused).toBe(1);

    placement.stopPlacement(true);
    expect(placement.positionPlacement).toBe(false);
    expect(placement.armedPart).toBeNull();
    expect(placement.isArmed(rect)).toBe(false);
    expect(state.focused).toBe(2);

    placement.togglePlacement();
    expect(placement.positionPlacement).toBe(true);
    expect(placement.armedPart).toBeNull();
    placement.togglePlacement();
    expect(placement.positionPlacement).toBe(false);
  });

  it("draft の確認を待つ drop は対象と点を変えず、待つ間に対象が変われば配置しない", () => {
    const { placement, gate, edits, reports, state } = setup();
    gate.allow = false;
    const token = placement.beginPartDrag(rect)!;
    expect(placement.canDropPart()).toBe(true);
    placement.dropPalettePart(token, { x: 5, y: 6 });
    expect(gate.held).toHaveLength(1);
    // 保留中の drag は消費済みで、同じ token の再 drop や新しい drag は受けない。
    expect(placement.canDropPart()).toBe(false);
    expect(placement.beginPartDrag(rect)).toBeNull();
    gate.held.shift()!();
    expect(edits).toEqual([
      {
        type: "add",
        screenId: "screen-1",
        kind: "rectangle",
        center: { x: 5, y: 6 },
      },
    ]);

    const second = placement.beginPartDrag(rect)!;
    placement.dropPalettePart(second, { x: 7, y: 8 });
    state.screenId = "screen-2";
    gate.held.shift()!();
    expect(edits).toHaveLength(1);
    expect(reports).toEqual([
      "配置先が変わったため、部品をもう一度配置してください。",
    ]);
  });
});
