// デモ用 Project（examples/demo-*.project.json）を組み立てる小さな道具。
// 保存形式は現行の schema（0.37.0）に合わせる。検査は build.mjs の後に
// `cargo run -p scada-model -- validate` とブラウザの読込で行う。
import { readFileSync } from "node:fs";

const library = JSON.parse(
  readFileSync(
    new URL(
      "../../apps/banto-scada/src/lib/symbol-library.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

/** 題材ごとに重ならない UUIDv7 形の id を順に作る。 */
export function idFactory(prefix) {
  let next = 0;
  return () =>
    `${prefix}-0000-7000-8000-${(++next).toString(16).padStart(12, "0")}`;
}

const solid = (color, alpha = 1) => ({ type: "solid", color, alpha });
const style = ({
  size = 14,
  weight = "normal",
  align = "left",
  wrap,
} = {}) => ({
  ...(wrap ? { wrap } : {}),
  fontSize: size,
  fontWeight: weight,
  align,
});

/** 画面または Symbol 定義の配置を、追加した順の重なりで集める。 */
export class Canvas {
  constructor(newId) {
    this.newId = newId;
    this.objects = [];
  }
  add(object) {
    const full = {
      id: this.newId(),
      order: this.objects.length,
      rotation: 0,
      ...object,
    };
    this.objects.push(full);
    return full;
  }
  rect(
    x,
    y,
    width,
    height,
    { fill, alpha = 1, stroke, strokeWidth = 2, name, stateText } = {},
  ) {
    return this.add({
      ...(name ? { name } : {}),
      x,
      y,
      width,
      height,
      shape: {
        type: "rectangle",
        paint: {
          fill: fill
            ? { enabled: true, paint: solid(fill, alpha) }
            : { enabled: false, paint: solid("#000000") },
          stroke: stroke ? { color: stroke, width: strokeWidth } : null,
        },
        ...(stateText ? { stateColor: { textId: stateText.id } } : {}),
      },
    });
  }
  text(
    x,
    y,
    width,
    height,
    text,
    { color = "#e2e8f0", name, visible, ...options } = {},
  ) {
    const { binding, format, boolDisplay, slot, stateColors, property } =
      options;
    return this.add({
      ...(name ? { name } : {}),
      ...(visible === false ? { visible: false } : {}),
      x,
      y,
      width,
      height,
      fill: color,
      shape: {
        type: "text",
        text,
        style: style(options),
        ...(binding ? { binding: { externalName: binding } } : {}),
        ...(slot ? { slotBinding: { slotName: slot } } : {}),
        ...(property ? { equipmentProperty: { field: property } } : {}),
        ...(stateColors ? { stateColors: { unknownColor: stateColors } } : {}),
        ...(format ? { format } : {}),
        ...(boolDisplay ? { boolDisplay } : {}),
      },
    });
  }
  /** 配管。`stateText` を渡すと、その Text の状態の色に追従する。 */
  pipe(
    points,
    {
      color = "#38bdf8",
      width = 6,
      arrow = "none",
      lineStyle,
      name,
      stateText,
    } = {},
  ) {
    return this.add({
      ...(name ? { name } : {}),
      x: 0,
      y: 0,
      fill: color,
      shape: {
        type: "polyline",
        ...(stateText ? { stateColor: { textId: stateText.id } } : {}),
        points: points.map(([x, y]) => ({ x, y })),
        strokeWidth: width,
        ...(lineStyle ? { lineStyle } : {}),
        arrow,
      },
    });
  }
  symbol(x, y, width, definition, equipment, { name } = {}) {
    return this.add({
      name: name ?? `${equipment.code} ${equipment.name}`,
      x,
      y,
      width,
      height: (width * definition.height) / definition.width,
      fill: "#94a3b8",
      shape: {
        type: "symbol",
        symbolId: definition.id,
        equipmentId: equipment.id,
        colorMode: "definition",
      },
    });
  }
  level(
    x,
    y,
    width,
    height,
    tag,
    {
      color = "#38bdf8",
      background = "#0f1b2d",
      min = 0,
      max = 100,
      direction = "up",
      name,
    } = {},
  ) {
    return this.add({
      ...(name ? { name } : {}),
      x,
      y,
      width,
      height,
      fill: color,
      shape: {
        type: "level",
        direction,
        min,
        max,
        background,
        binding: { externalName: tag },
      },
    });
  }
  table(
    x,
    y,
    width,
    height,
    {
      columns,
      rows,
      cells,
      color = "#e2e8f0",
      border = "#475569",
      background,
      name,
      ...options
    },
  ) {
    return this.add({
      ...(name ? { name } : {}),
      x,
      y,
      width,
      height,
      fill: color,
      shape: {
        type: "table",
        columns,
        rows: rows ?? cells.map(() => 1),
        cells: cells.map((row) =>
          row.map((cell) => (typeof cell === "string" ? { text: cell } : cell)),
        ),
        style: style({ align: "center", ...options }),
        border: { color: border, width: 1 },
        ...(background ? { background } : {}),
      },
    });
  }
  nav(
    x,
    y,
    width,
    height,
    label,
    target,
    { size = 15, fill = "#1e293b", textColor = "#e2e8f0" } = {},
  ) {
    return this.add({
      name: `画面切替 ${label}`,
      x,
      y,
      width,
      height,
      shape: {
        type: "navButton",
        target,
        label,
        fontSize: size,
        fill,
        textColor,
        currentFill: "#0ea5e9",
        currentTextColor: "#0b1220",
      },
    });
  }
  clock(
    x,
    y,
    width,
    height,
    { color = "#e2e8f0", format = "dateTime", ...options } = {},
  ) {
    return this.add({
      name: "時計",
      x,
      y,
      width,
      height,
      fill: color,
      shape: { type: "clock", format, seconds: true, style: style(options) },
    });
  }
  badge(x, y, width, height, text, alarmId, limit, { size = 12 } = {}) {
    return this.add({
      name: `警報の小札 ${text}`,
      x,
      y,
      width,
      height,
      shape: {
        type: "alarmBadge",
        alarmId,
        ...(limit ? { limit } : {}),
        text,
        style: { fontSize: size, fontWeight: "bold" },
      },
    });
  }
  banner(x, y, width, height, { size = 14 } = {}) {
    return this.add({
      name: "最新の警報の帯",
      x,
      y,
      width,
      height,
      shape: {
        type: "alarmBanner",
        style: { fontSize: size, fontWeight: "normal" },
      },
    });
  }
  trend(x, y, width, height, trendId) {
    return this.add({
      name: "履歴トレンド",
      x,
      y,
      width,
      height,
      shape: { type: "trend", trendId },
    });
  }
}

/** bool のタグを文字と色にする画面直下の Text の指定。 */
export const boolDisplay = (
  on,
  off,
  { onColor = "#22c55e", offColor = "#64748b" } = {},
) => ({
  true: { text: on, color: onColor },
  false: { text: off, color: offColor },
  unknownColor: "#d97706",
});

/**
 * 内蔵部品の線画に、機器コードの文字と状態の文字を足した Symbol 定義を作る。
 * 線は状態の文字の色に追従する。`stateVisible` が false なら状態の文字は出さず、色だけ使う。
 */
export function equipmentSymbol(
  newId,
  template,
  { name, slot, slotType, stateVisible = true, textSize = 16 },
) {
  const source = library[template];
  const row = Math.round(textSize * 1.4);
  const top = row,
    bottom = stateVisible ? row : 0;
  const canvas = new Canvas(newId);
  canvas.text(0, 0, source.width, row - 2, "CODE", {
    name: "機器コード",
    size: textSize,
    weight: "bold",
    align: "center",
    color: "#e2e8f0",
    property: "code",
  });
  const state = canvas.text(
    0,
    top + source.height,
    source.width,
    row - 2,
    "状態",
    {
      name: "状態の文字",
      size: textSize,
      weight: "bold",
      align: "center",
      color: "#94a3b8",
      slot,
      stateColors: "#d97706",
      ...(stateVisible ? {} : { visible: false }),
    },
  );
  for (const line of source.objects) {
    canvas.pipe(
      line.shape.points.map((point) => [point.x, point.y + top]),
      { color: "#94a3b8", width: line.shape.strokeWidth, stateText: state },
    );
  }
  return {
    readSlots: [{ name: slot, type: slotType, direction: "read" }],
    folders: [],
    id: newId(),
    name,
    width: source.width,
    height: top + source.height + bottom,
    objects: canvas.objects,
    /** 左右の接続の線の高さ（定義の座標）。配管をつなぐ位置の計算に使う。 */
    stubY: top + source.objects.at(-1).shape.points[0].y,
  };
}

export function screen(
  id,
  name,
  width,
  height,
  background,
  canvas,
  extra = {},
) {
  return {
    groups: [],
    folders: [],
    background,
    ...extra,
    id,
    name,
    width,
    height,
    objects: canvas.objects,
  };
}

/** 生成用の補助の項目を落とし、保存形式だけにする。 */
export function definitionOnly({ stubY: _stubY, ...definition }) {
  return definition;
}

/**
 * 左右の接続の線が `stubY` の高さに来るように Symbol を置く。
 * 戻り値の `left`・`right` は配管をつなぐ点。
 */
export function placeOnLine(canvas, definition, equipment, x, stubY, width) {
  const scale = width / definition.width;
  const placed = canvas.symbol(
    x,
    stubY - definition.stubY * scale,
    width,
    definition,
    equipment,
  );
  return { placed, left: [x, stubY], right: [x + width, stubY] };
}
