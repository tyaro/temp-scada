<script lang="ts">
  import TextPrimitive from "./TextPrimitive.svelte";
  import { formatClock } from "./clock-format";
  import { clockNow } from "./clock-ticker.svelte";
  import type { ClockShape } from "./project";
  let {
    shape,
    width,
    height,
    color,
  }: { shape: ClockShape; width: number; height: number; color: string } =
    $props();
  const text = $derived(formatClock(shape, clockNow()));
</script>

<TextPrimitive {text} {width} {height} style={shape.style} {color} />
