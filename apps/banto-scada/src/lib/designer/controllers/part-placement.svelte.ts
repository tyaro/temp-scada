import { tick } from "svelte";
import type { EditCommand } from "../../editor";
import type { Point, SymbolDefinition } from "../../project";
import { DEFAULT_FAVORITES, favoriteKey, FAVORITES_LIMIT } from "../favorites";
import type { PalettePart } from "../palette-drag";

/**
 * 部品の配置（R7d）。お気に入り・連続配置・パレットからの drag の状態と、
 * それを読み書きする処理を持つ。Project・history・未適用入力のゲート（`edit`／
 * `transition`）とキャンバスのフォーカスは App が持ち、host から受け取る。
 */
export interface PartPlacementHost {
  readonly projectId: string;
  readonly symbols: readonly SymbolDefinition[];
  /** 配置先のキャンバス ID（画面 ID、または編集中の Symbol 定義 ID）。 */
  readonly screenId: string;
  readonly generation: number;
  readonly mode: "edit" | "preview";
  /** Symbol 定義の編集中（基本図形だけを置ける）。 */
  readonly definition: boolean;
  readonly busy: boolean;
  /** 未適用入力の確認待ち（`drafts.pending`）。 */
  readonly draftPending: boolean;
  readonly replacing: boolean;
  /** 未適用入力のゲート（App の `transition`）。通過したら `run` を呼ぶ。 */
  transition(run: () => void): void;
  edit(command: EditCommand): boolean;
  /** 表示中のキャンバスの中心。キャンバスが無ければ `undefined`。 */
  visibleCenter(): Point | undefined;
  setHand(value: boolean): void;
  focusCanvas(): void;
  showPartsPanel(): void;
  loadFavorites(): string[];
  saveFavorites(keys: string[]): Promise<void>;
  report(kind: "warning" | "error", text: string): void;
}

export function createPartPlacementController(host: PartPlacementHost) {
  let favoriteKeys = $state(host.loadFavorites());
  let positionPlacement = $state(false);
  let armedPart = $state<PalettePart | null>(null);
  let placementTicket = 0;
  let paletteDrag: {
    token: string;
    part: PalettePart;
    generation: number;
    target: string;
  } | null = null;

  const keyOf = (part: PalettePart) => favoriteKey(part, host.projectId);
  // 配置を受け付けない状態（編集モード以外・処理中・確認待ち・置換中・定義の編集中の Symbol）。
  const refuses = (part: PalettePart) =>
    host.mode !== "edit" ||
    host.busy ||
    host.draftPending ||
    host.replacing ||
    (host.definition && part.type !== "basic");

  function isFavorite(part: PalettePart) {
    return favoriteKeys.includes(keyOf(part));
  }
  function toggleFavorite(part: PalettePart) {
    const key = keyOf(part);
    if (favoriteKeys.includes(key))
      favoriteKeys = favoriteKeys.filter((item) => item !== key);
    else {
      if (favoriteKeys.length >= FAVORITES_LIMIT) {
        host.report(
          "warning",
          "お気に入りは64件までです。使わない部品を外してから登録してください。",
        );
        return;
      }
      favoriteKeys = [...favoriteKeys, key];
    }
    void host.saveFavorites(favoriteKeys);
  }
  function resetFavorites() {
    favoriteKeys = [...DEFAULT_FAVORITES];
    void host.saveFavorites(favoriteKeys);
  }

  function stopPlacement(focus = false) {
    positionPlacement = false;
    armedPart = null;
    placementTicket++;
    if (focus) host.focusCanvas();
  }
  function togglePlacement() {
    if (positionPlacement) stopPlacement();
    else {
      positionPlacement = true;
      host.setHand(false);
    }
  }
  function armPart(part: PalettePart) {
    if (refuses(part)) return;
    if (
      part.type === "symbol" &&
      !host.symbols.some((definition) => definition.id === part.symbolId)
    )
      return;
    placementTicket++;
    positionPlacement = true;
    armedPart = part;
    host.setHand(false);
    const ticket = placementTicket;
    void tick().then(() => {
      if (!(
        document.activeElement instanceof Element &&
        document.activeElement.closest(
          "input,textarea,select,[contenteditable]",
        )
      ))
        focusPlacement(ticket);
    });
  }
  function focusPlacement(ticket: number) {
    if (
      host.mode === "edit" &&
      positionPlacement &&
      ticket === placementTicket &&
      !host.busy &&
      !host.draftPending &&
      !host.replacing
    )
      host.focusCanvas();
  }
  function isArmed(part: PalettePart) {
    return !!armedPart && keyOf(part) === keyOf(armedPart);
  }
  function choosePart(part: PalettePart) {
    if (positionPlacement) armPart(part);
    else placeFavorite(part);
  }
  function placeArmed(center: Point) {
    if (!positionPlacement || !armedPart) return;
    const ticket = placementTicket;
    const token = startPaletteDrag(armedPart);
    if (token)
      dropPalettePart(
        token,
        center,
        () => positionPlacement && ticket === placementTicket,
        () => focusPlacement(ticket),
      );
  }
  function beginPartDrag(part: PalettePart) {
    stopPlacement();
    return startPaletteDrag(part);
  }
  function placeFavorite(part: PalettePart) {
    const center = host.visibleCenter();
    const token = center && startPaletteDrag(part);
    if (token && center) dropPalettePart(token, center);
  }

  function startPaletteDrag(part: PalettePart): string | null {
    if (refuses(part)) return null;
    const token = crypto.randomUUID();
    paletteDrag = {
      token,
      part,
      generation: host.generation,
      target: host.screenId,
    };
    return token;
  }
  function canDropPart(): boolean {
    return (
      host.mode === "edit" &&
      !host.busy &&
      !host.draftPending &&
      !host.replacing &&
      !!paletteDrag &&
      paletteDrag.generation === host.generation &&
      paletteDrag.target === host.screenId
    );
  }
  function dropPalettePart(
    token: string,
    center: Point,
    valid: () => boolean = () => true,
    onplaced?: () => void,
  ) {
    const drag = paletteDrag;
    if (!drag || drag.token !== token || !canDropPart()) return;
    paletteDrag = null;
    // Capture the target and point before the draft prompt; never retarget a deferred drop.
    host.transition(() => {
      if (!valid()) return;
      if (
        host.mode !== "edit" ||
        drag.generation !== host.generation ||
        drag.target !== host.screenId
      ) {
        host.report(
          "error",
          "配置先が変わったため、部品をもう一度配置してください。",
        );
        return;
      }
      const part = drag.part;
      if (host.definition && part.type !== "basic") return;
      let committed: boolean;
      if (part.type === "basic")
        committed = host.edit({
          type: "add",
          screenId: drag.target,
          kind: part.kind,
          center,
        });
      else if (part.type === "builtin")
        committed = host.edit({
          type: "add-symbol",
          screenId: drag.target,
          template: part.template,
          center,
        });
      else
        committed = host.edit({
          type: "place-symbol",
          screenId: drag.target,
          symbolId: part.symbolId,
          center,
        });
      if (committed) onplaced?.();
    });
  }

  return {
    get favoriteKeys(): string[] {
      return favoriteKeys;
    },
    get positionPlacement() {
      return positionPlacement;
    },
    get armedPart(): PalettePart | null {
      return armedPart;
    },
    isFavorite,
    toggleFavorite,
    resetFavorites,
    stopPlacement,
    togglePlacement,
    armPart,
    isArmed,
    choosePart,
    placeArmed,
    placeFavorite,
    browseParts: () => host.showPartsPanel(),
    beginPartDrag,
    canDropPart,
    dropPalettePart,
    /** パレットの drag の終了、または配置先の変化で保留中の drag を捨てる。 */
    endPaletteDrag() {
      paletteDrag = null;
    },
  };
}

export type PartPlacementController = ReturnType<
  typeof createPartPlacementController
>;
