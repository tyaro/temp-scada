import {
  THREE_PANE_IDS,
  threePaneDockLayout,
  type DockLayout,
  type DockNode,
  type DockPanelNode,
  type DockState,
} from "@banto/dock-svelte";

/**
 * 隠した pane を出し直す場所（`dock.defaultLayout`）を Designer の既定の配置に固定する。
 *
 * Banto v8（#782 PR5）から、隠した pane は隠した場所ではなく `defaultLayout` の場所へ
 * 戻る。`ThreePaneDock` は自分の既定（追加の pane を `initial` の端へ 1 つずつ並べる）を
 * 何度も入れ直すので、そのままではレイヤー・部品が左のタブの組へ戻らず、左の端に
 * 別の区画として積まれる。Designer の pane は固定なので、既定の場所は `layout`
 * （`designerDockLayout` の結果）のまま変えず、`ThreePaneDock` の書き込みは捨てる。
 */
export function pinDesignerDefaultPlaces(
  dock: DockState,
  layout: DockLayout,
): void {
  Object.defineProperty(dock, "defaultLayout", {
    configurable: true,
    enumerable: true,
    get: () => layout,
    set: () => {},
  });
}

/**
 * Designer の枠（#331 D2）。`ThreePaneDock` の左 = Project、中央 = 画面プレビュー、
 * 右 = Inspector に、追加パネルのレイヤー・部品を足す。左3つは既定で左の区画に
 * dock のタブとしてまとめ、最初は Project が表。
 */
export const DESIGNER_PANE_IDS = {
  project: THREE_PANE_IDS.left,
  layers: "layers",
  parts: "parts",
  inspector: THREE_PANE_IDS.right,
} as const;
export type DesignerLeftPane = "project" | "layers" | "parts";
export const DESIGNER_LEFT_PANES: readonly DesignerLeftPane[] = [
  "project",
  "layers",
  "parts",
];
export const DESIGNER_PANE_TITLES = {
  project: "プロジェクト",
  layers: "レイヤー",
  parts: "部品",
  center: "キャンバス",
  inspector: "プロパティ",
} as const;
/** 今までの 1100px 未満の切り替えと同じ幅で、dock の狭い表示にする。 */
export const DESIGNER_NARROW_BREAKPOINT = 1099;
const LEFT_TABS_ID = "designer:left-tabs";

export interface DesignerDockLayoutOptions {
  hostWidth: number;
  leftWidth: number;
  rightWidth: number;
}

/**
 * 最初の配置: 左の区画に Project・レイヤー・部品のタブ（Project が表）、中央、右に
 * Inspector。幅は `threePaneDockLayout` と同じく px を host の幅の比率へ直す。
 * 配置の保存は D3 なので、毎回この配置から始める。
 */
export function designerDockLayout(
  options: DesignerDockLayoutOptions,
): DockLayout {
  const base = threePaneDockLayout({
    hostWidth: options.hostWidth,
    leftWidth: options.leftWidth,
    rightWidth: options.rightWidth,
    panels: {
      left: { title: DESIGNER_PANE_TITLES.project },
      center: { title: DESIGNER_PANE_TITLES.center },
      right: { title: DESIGNER_PANE_TITLES.inspector },
    },
  });
  const pane = (id: string, title: string): DockPanelNode => ({
    type: "panel",
    id,
    title,
  });
  const tabs: DockNode = {
    type: "tabs",
    id: LEFT_TABS_ID,
    activeIndex: 0,
    children: [
      pane(DESIGNER_PANE_IDS.project, DESIGNER_PANE_TITLES.project),
      pane(DESIGNER_PANE_IDS.layers, DESIGNER_PANE_TITLES.layers),
      pane(DESIGNER_PANE_IDS.parts, DESIGNER_PANE_TITLES.parts),
    ],
  };
  const root = base.docked;
  if (root?.type !== "split")
    throw new Error("designerDockLayout: 既定の配置が左右の分割ではありません");
  return {
    ...base,
    docked: {
      ...root,
      children: root.children.map((child) =>
        child.type === "panel" && child.id === DESIGNER_PANE_IDS.project
          ? tabs
          : child,
      ),
    },
  };
}

/**
 * 左のパネルのうち、今画面で表に出ているもの（タブの組なら選択中のタブ、単独の
 * pane ならそれ自身）。メニューや文脈の鍵の失効に使う。
 */
export function frontLeftPanes(layout: DockLayout): DesignerLeftPane[] {
  const ids = new Map<string, DesignerLeftPane>(
    DESIGNER_LEFT_PANES.map((pane) => [DESIGNER_PANE_IDS[pane], pane]),
  );
  const front: DesignerLeftPane[] = [];
  const visit = (node: DockNode | null) => {
    if (!node) return;
    if (node.type === "panel") {
      const pane = ids.get(node.id);
      if (pane) front.push(pane);
    } else if (node.type === "tabs") {
      const pane = ids.get(node.children[node.activeIndex]?.id ?? "");
      if (pane) front.push(pane);
    } else node.children.forEach(visit);
  };
  visit(layout.docked);
  for (const hidden of layout.autoHidden ?? []) visit(hidden.node);
  for (const window of layout.floating) {
    const pane = ids.get(window.id);
    if (pane && window.open) front.push(pane);
  }
  return front;
}

function containsPane(node: DockNode, id: string): boolean {
  if (node.type === "panel") return node.id === id;
  return node.children.some((child) => containsPane(child, id));
}

function paneIds(node: DockNode): string {
  if (node.type === "panel") return node.id;
  return node.children.map(paneIds).sort().join(",");
}

/**
 * 「補助パネルを元の表示に戻す」: 根の横の分割の幅を `before`（まとめて隠す前の配置）に
 * 合わせ直す。Banto v8 は隠した pane を 1 つずつ戻し、後から戻した pane の分だけ先に
 * 戻した pane を縮めるので、そのままでは左の幅が変わる。根の分割の区画の並びと各区画の
 * pane が `before` と同じときだけ幅を写し、違えばそのまま返す。隠している間に窓の幅が
 * 変わったときは `widths`（隠す前の幅と今の幅）で換算し、左右の区画を隠す前の px に戻す。
 */
export function withDesignerRootSizes(
  layout: DockLayout,
  before: DockLayout,
  widths?: { from: number; to: number },
): DockLayout {
  const root = layout.docked;
  const old = before.docked;
  if (
    root?.type !== "split" ||
    old?.type !== "split" ||
    root.direction !== old.direction ||
    root.children.length !== old.children.length ||
    root.children.some(
      (child, index) => paneIds(child) !== paneIds(old.children[index]),
    )
  )
    return layout;
  const copied = { ...layout, docked: { ...root, sizes: [...old.sizes] } };
  return widths
    ? keepDesignerPaneWidths(copied, widths.from, widths.to)
    : copied;
}

/**
 * 「パネルの幅を標準に戻す」: 根の横の分割のうち、左のパネルを含む区画と Inspector を
 * 含む区画の幅だけを既定の px に戻す（配置は変えない）。根が横の分割でないとき・
 * 中央を含む区画が無いときはそのまま返す。
 */
export function withDesignerPaneWidths(
  layout: DockLayout,
  options: DesignerDockLayoutOptions,
): DockLayout {
  const root = layout.docked;
  if (root?.type !== "split" || root.direction !== "row") return layout;
  const width = options.hostWidth > 0 ? options.hostWidth : 1280;
  const leftIds = DESIGNER_LEFT_PANES.map((pane) => DESIGNER_PANE_IDS[pane]);
  const kinds = root.children.map((child) =>
    containsPane(child, THREE_PANE_IDS.center)
      ? "center"
      : leftIds.some((id) => containsPane(child, id))
        ? "left"
        : containsPane(child, DESIGNER_PANE_IDS.inspector)
          ? "right"
          : "other",
  );
  const center = kinds.indexOf("center");
  if (center < 0) return layout;
  const sizes = [...root.sizes];
  let fixed = 0;
  kinds.forEach((kind, index) => {
    if (kind === "left") sizes[index] = options.leftWidth / width;
    else if (kind === "right") sizes[index] = options.rightWidth / width;
    if (index !== center) fixed += sizes[index];
  });
  const room = Math.max(0.2, 1 - fixed);
  sizes[center] = room;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return {
    ...layout,
    docked: { ...root, sizes: sizes.map((size) => size / total) },
  };
}

/**
 * 窓の幅が変わっても左右の区画の px を保つ（今までの固定幅と同じ見え方。dock の分割は
 * 比率なので、そのままでは窓に合わせて左右も縮む）。根の横の分割の中央以外の区画を
 * `fromWidth` での px のまま `toWidth` の比率へ直し、中央は残り（最低 320px。足りなければ
 * 左右を同じ割合で縮める）。根が横の分割でない・中央が無いときはそのまま返す。
 */
export function keepDesignerPaneWidths(
  layout: DockLayout,
  fromWidth: number,
  toWidth: number,
): DockLayout {
  const root = layout.docked;
  if (
    fromWidth <= 0 ||
    toWidth <= 0 ||
    fromWidth === toWidth ||
    root?.type !== "split" ||
    root.direction !== "row"
  )
    return layout;
  const center = root.children.findIndex((child) =>
    containsPane(child, THREE_PANE_IDS.center),
  );
  if (center < 0) return layout;
  const px = root.sizes.map((size) => size * fromWidth);
  const sides = px.reduce(
    (sum, value, index) => (index === center ? sum : sum + value),
    0,
  );
  const room = Math.max(0, toWidth - 320);
  const scale = sides > room && sides > 0 ? room / sides : 1;
  const sizes = px.map((value, index) =>
    index === center ? 0 : (value * scale) / toWidth,
  );
  sizes[center] = Math.max(0, 1 - sizes.reduce((sum, size) => sum + size, 0));
  return { ...layout, docked: { ...root, sizes } };
}
