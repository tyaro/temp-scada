<script lang="ts">
  import { onMount } from "svelte";
  import {
    ThreePaneDock,
    createDockState,
    type DockPanelChange,
  } from "@banto/dock-svelte";
  import sample from "../../../../../examples/shape-label.project.json";
  import { isAreaShape, parseProject } from "../../lib/project";
  import { createDraftGuard } from "../../lib/designer/drafts.svelte";
  import ShapeLabel from "../../lib/designer/ShapeLabel.svelte";

  // #331 D1: 実フォーム1枚（図形の文字）を persistent のパネルに入れ、
  // ドッキング・浮動・タブ・隠す・狭い表示で DOM と未適用の入力が保たれるかを見る。
  // 操作は e2e/dock-probe.spec.ts が window.__dockProbe から呼ぶ。
  const project = parseProject(JSON.stringify(sample));
  const screen = project.screens[0];
  const object = screen.objects.find(
    (item) => isAreaShape(item.shape) && !!item.shape.label,
  )!;
  const errors: string[] = [];
  const drafts = createDraftGuard(
    (message) => errors.push(message),
    () => true,
  );
  const dock = createDockState();
  const changes: DockPanelChange[] = [];
  let submits = 0;
  let narrowOverride = $state(false);
  let narrow = $state(false);
  let threePane: ReturnType<typeof ThreePaneDock> | undefined = $state();

  /** 聞かれた変更を控えるだけで、すべて許す（据え置きの pane は remount: false のはず）。 */
  function beforePanelChange(change: DockPanelChange) {
    changes.push(change);
    return true;
  }

  onMount(() => {
    (window as unknown as { __dockProbe: unknown }).__dockProbe = {
      get threePane() {
        return threePane;
      },
      dock,
      drafts,
      changes,
      errors,
      get submits() {
        return submits;
      },
      get narrow() {
        return narrow;
      },
      setNarrow(value: boolean) {
        narrowOverride = value;
      },
    };
  });
</script>

<div class="probe">
  <ThreePaneDock
    bind:this={threePane}
    bind:narrow
    {dock}
    {narrowOverride}
    {beforePanelChange}
    persistent={(id) => id === "right"}
    messages={{
      threePaneLeft: () => "プロジェクト",
      threePaneCenter: () => "キャンバス",
      threePaneRight: () => "プロパティ",
    }}
  >
    {#snippet left()}
      <p class="note">左パネル（中身なし）</p>
    {/snippet}
    {#snippet right()}
      <div class="inspector">
        <ShapeLabel
          {object}
          background={screen.background}
          targetKey={`object:${object.id}`}
          locked={false}
          {drafts}
          onsubmit={(event) => {
            // 確定（Project への適用）はせず、submit の発火の回数だけを数える。
            event.preventDefault();
            submits++;
          }}
        />
      </div>
    {/snippet}
    <div class="canvas" data-probe-canvas>キャンバス（実証用の空き領域）</div>
  </ThreePaneDock>
</div>

<style>
  :global(body) {
    margin: 0;
    background: var(--banto-bg);
    color: var(--banto-text);
  }
  .probe {
    height: 100vh;
  }
  .note,
  .canvas {
    padding: 12px;
    color: var(--banto-text-muted);
    font-size: 12px;
  }
  .canvas {
    height: 100%;
    box-sizing: border-box;
  }
  .inspector {
    padding: 12px;
  }
</style>
