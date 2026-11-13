<script lang="ts">
  import type { TableShape } from "./project";
  import { tableCellBoxes, tableEdges } from "./table";
  import { TEXT_FONT } from "./text-layout";
  let {
    shape,
    width,
    height,
    textColor,
    color,
    textAlpha,
  }: {
    shape: TableShape;
    width: number;
    height: number;
    /** セルに文字色がないときの色（配置の色）。 */
    textColor: string;
    /** 単色の Symbol 配置の色。文字と罫線をこの色にする（塗りは変えない）。 */
    color?: string;
    textAlpha?: number;
  } = $props();
  const PADDING = 4;
  const boxes = $derived(tableCellBoxes(shape, width, height));
  const xs = $derived(tableEdges(shape.columns, width));
  const ys = $derived(tableEdges(shape.rows, height));
  const anchor = $derived(
    shape.style.align === "left"
      ? "start"
      : shape.style.align === "right"
        ? "end"
        : "middle",
  );
  function textX(boxWidth: number) {
    return shape.style.align === "left"
      ? PADDING
      : shape.style.align === "right"
        ? boxWidth - PADDING
        : boxWidth / 2;
  }
  const grid = $derived.by(() => {
    if (!shape.border) return "";
    const inner = [
      ...xs.slice(1, -1).map((x) => `M${x} 0V${height}`),
      ...ys.slice(1, -1).map((y) => `M0 ${y}H${width}`),
    ];
    return inner.join("");
  });
</script>

<g
  data-table
  data-table-rows={shape.rows.length}
  data-table-columns={shape.columns.length}
>
  {#if shape.background}<rect
      data-table-background
      {width}
      {height}
      fill={shape.background}
    />{/if}
  {#each boxes as box (`${box.row}:${box.column}`)}
    <svg
      x={box.x}
      y={box.y}
      width={box.width}
      height={box.height}
      overflow="hidden"
      data-table-cell={`${box.row}:${box.column}`}
    >
      {#if box.cell.fill}<rect
          width={box.width}
          height={box.height}
          fill={box.cell.fill}
        />{/if}
      {#if box.cell.text}<text
          data-table-text
          x={textX(box.width)}
          y={box.height / 2}
          dominant-baseline="central"
          text-anchor={anchor}
          font-family={TEXT_FONT}
          font-size={shape.style.fontSize}
          font-weight={shape.style.fontWeight}
          fill={color ?? box.cell.color ?? textColor}
          fill-opacity={textAlpha}>{box.cell.text}</text
        >{/if}
    </svg>
  {/each}
  {#if shape.border}
    <path
      data-table-grid
      d={grid}
      fill="none"
      stroke={color ?? shape.border.color}
      stroke-width={shape.border.width}
    />
    <rect
      data-table-frame
      x={shape.border.width / 2}
      y={shape.border.width / 2}
      width={Math.max(0, width - shape.border.width)}
      height={Math.max(0, height - shape.border.width)}
      fill="none"
      stroke={color ?? shape.border.color}
      stroke-width={shape.border.width}
    />
  {/if}
</g>
