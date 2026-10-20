<script lang="ts">
  import { onMount } from "svelte";
  import {
    DockHost,
    createDockState,
  } from "../banto/packages/dock-svelte/src/index";
  import { createDraftGuard } from "__SCADA_ROOT__/apps/banto-scada/src/lib/designer/drafts.svelte";
  import Probe from "./Probe.svelte";
  const guard = createDraftGuard(
    () => {},
    () => true,
  );
  const dock = createDockState({
    version: 2,
    floating: [
      {
        id: "a",
        title: "A",
        x: 40,
        y: 40,
        width: 320,
        height: 280,
        open: true,
      },
      {
        id: "d",
        title: "D",
        x: 440,
        y: 70,
        width: 320,
        height: 280,
        open: true,
      },
    ],
    docked: {
      type: "tabs",
      id: "tabs",
      children: [
        { type: "panel", id: "b", title: "B" },
        { type: "panel", id: "c", title: "C" },
      ],
      activeIndex: 0,
    },
  });
  onMount(() => {
    (window as any).evaluation = { dock, guard };
  });
</script>

<nav>
  <button onclick={() => dock.dockPanel("a", "tabs", "right")}>Dock A</button
  ><button onclick={() => dock.close("a")}>Close A</button><button
    onclick={() => dock.open("a")}>Open A</button
  ><button onclick={() => dock.setActiveTab("tabs", 1)}>Tab C</button><button
    onclick={() => dock.setActiveTab("tabs", 0)}>Tab B</button
  >
</nav>
<p data-dirty>dirty={guard.count}</p>
<div class="host">
  <DockHost {dock}
    >{#snippet panel(content)}{#key content.id}<Probe
          id={content.id}
          {guard}
        />{/key}{/snippet}</DockHost
  >
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: sans-serif;
  }
  nav {
    display: flex;
    gap: 12px;
    padding: 12px;
  }
  button {
    padding: 8px;
  }
  .host {
    position: relative;
    width: 1000px;
    height: 650px;
    border: 1px solid #aaa;
    margin: 10px;
  }
</style>
