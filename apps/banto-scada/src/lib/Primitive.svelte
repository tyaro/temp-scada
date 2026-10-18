<script lang="ts">
  import type { ScreenObject } from "./project";
  let { object, color }: { object: ScreenObject; color?: string } = $props();
  const shape = $derived("width" in object ? null : object.shape);
  function arrowPoints() {
    if (!shape || shape.arrow !== "end") return "";
    const end = shape.points.at(-1)!;
    const before = [...shape.points]
      .reverse()
      .find((p) => p.x !== end.x || p.y !== end.y)!;
    const length = Math.hypot(end.x - before.x, end.y - before.y);
    const ux = (end.x - before.x) / length,
      uy = (end.y - before.y) / length;
    const size = Math.max(8, shape.strokeWidth * 3);
    return `${end.x},${end.y} ${end.x - ux * size - (uy * size) / 2},${end.y - uy * size + (ux * size) / 2} ${end.x - ux * size + (uy * size) / 2},${end.y - uy * size - (ux * size) / 2}`;
  }
</script>

{#if "width" in object}
  {#if object.shape.type === "rectangle"}<rect
      width={object.width}
      height={object.height}
      fill={color ?? object.fill}
    />
  {:else if object.shape.type === "ellipse"}<ellipse
      cx={object.width / 2}
      cy={object.height / 2}
      rx={object.width / 2}
      ry={object.height / 2}
      fill={color ?? object.fill}
    />
  {:else if object.shape.type === "text"}<text
      x="0"
      y={object.height * 0.8}
      font-size={object.height * 0.7}
      fill={color ?? object.fill}>{object.shape.text}</text
    >{/if}
{:else if shape}
  <polyline
    points={shape.points.map((p) => `${p.x},${p.y}`).join(" ")}
    stroke={color ?? object.fill}
    stroke-width={shape.strokeWidth}
    stroke-linejoin="round"
    stroke-linecap="round"
    fill="none"
  />
  {#if shape.arrow === "end"}<polygon
      points={arrowPoints()}
      fill={color ?? object.fill}
    />{/if}
{/if}
