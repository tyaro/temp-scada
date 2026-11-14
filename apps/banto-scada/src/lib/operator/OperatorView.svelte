<script lang="ts">
  import { onMount, untrack, type Snippet } from "svelte";
  import { hasVisibleLayerAbove } from "@banto/ui";
  import Renderer from "../Renderer.svelte";
  import PreviewFullscreen from "../designer/PreviewFullscreen.svelte";
  import PreviewPopups from "../designer/PreviewPopups.svelte";
  import type { NavTarget, Project, Screen } from "../project";
  import type { TagReadings } from "../tag-presentation";
  import type { EquipmentContext } from "../symbol-slots";
  import {
    canGoBack,
    canGoForward,
    currentScreen,
    goBack,
    goForward,
    pushScreen,
    startHistory,
  } from "./operator-history";
  import { operatorLayout, type Box } from "./operator-layout";

  /**
   * 運転表示。枠（ヘッダー・フッター）と主画面を窓に収めて描き、画面切替ボタンで自前の履歴を動かす。
   * Designer の画面・選択・画面タブは変えない。表示確認の一形態で、書込み・外部 Action はない。
   * 仕様: docs/design/graphics/operator-frame.md
   */
  let {
    project,
    startScreenId,
    images,
    readings,
    equipmentContext,
    onclose,
    onmessage,
    onopentrend,
    onretiretrend,
    overlay,
  }: {
    project: Project;
    startScreenId: string;
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
    readings?: TagReadings;
    equipmentContext?: EquipmentContext;
    onclose: () => void;
    onmessage: (message: string) => void;
    /** トレンドの配置から履歴の窓を開く（主画面・枠・画面の小窓のどれからでも）。 */
    onopentrend?: (screenId: string, objectId: string, token?: object) => void;
    onretiretrend?: (token: object) => void;
    /** 運転表示の上に重ねる窓（履歴トレンド）。運転表示の中に描くので裏の inert を受けない。 */
    overlay?: Snippet;
  } = $props();

  // 開始画面は開いたときに一度だけ決める（以後は履歴が持つ）。
  let history = $state.raw(startHistory(untrack(() => startScreenId)));
  let root = $state<HTMLElement>();
  let stageWidth = $state(0),
    stageHeight = $state(0);
  let popups = $state<{
    showEquipment: (id: string, origin: HTMLElement | SVGElement) => void;
  }>();

  const find = (id: string | undefined) =>
    id ? project.screens.find((s) => s.id === id) : undefined;
  const currentId = $derived(currentScreen(history));
  const main = $derived(find(currentId));
  const header = $derived(find(project.operatorFrame?.headerScreenId));
  const footer = $derived(find(project.operatorFrame?.footerScreenId));
  const navHistory = $derived({
    canBack: canGoBack(history),
    canForward: canGoForward(history),
  });
  const layout = $derived(
    main
      ? operatorLayout(
          { width: stageWidth, height: stageHeight },
          main,
          header,
          footer,
        )
      : undefined,
  );

  function navigate(target: NavTarget) {
    if (target.kind === "back") history = goBack(history);
    else if (target.kind === "forward") history = goForward(history);
    else if (find(target.screenId))
      history = pushScreen(history, target.screenId);
  }
  function openEquipment(id: string, origin: SVGElement) {
    popups?.showEquipment(id, origin);
  }
  function escape(event: KeyboardEvent) {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      hasVisibleLayerAbove({ except: root })
    )
      return;
    event.preventDefault();
    onclose();
  }
  // 運転表示の間は Designer の UI を操作できないようにする（Tab で裏へ移らない）。
  onMount(() => {
    const host = root?.parentElement;
    const others = host
      ? [...host.children].filter(
          (element): element is HTMLElement =>
            element !== root &&
            element instanceof HTMLElement &&
            !element.inert &&
            !element.classList.contains("toast-anchor"),
        )
      : [];
    for (const element of others) element.inert = true;
    root?.focus();
    return () => {
      for (const element of others) element.inert = false;
    };
  });
  const place = (box: Box) =>
    `left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px`;
</script>

<svelte:window onkeydown={escape} />

{#snippet region(screen: Screen, box: Box, role: string)}
  <div class="region" data-operator-region={role} style={place(box)}>
    {#key screen.id}
      <Renderer
        {screen}
        symbols={project.symbols}
        screens={project.screens}
        trends={project.trends}
        {images}
        {readings}
        {equipmentContext}
        currentScreenId={currentId}
        {navHistory}
        onnavigate={navigate}
        onopenequipment={openEquipment}
        onopentrend={onopentrend
          ? (objectId) => onopentrend(screen.id, objectId)
          : undefined}
      />
    {/key}
  </div>
{/snippet}

<div
  class="operator-view"
  bind:this={root}
  role="region"
  aria-label="運転表示"
  tabindex="-1"
  data-operator-screen={currentId}
>
  <div class="operator-bar" role="toolbar" aria-label="運転表示の操作">
    <strong>運転表示</strong>
    <span class="current" data-testid="operator-current"
      >{main?.name ?? "画面が見つかりません"}</span
    >
    <span class="note">表示確認（書込みなし）</span>
    <div class="actions">
      <PreviewFullscreen scope="operator" onactive={() => {}} {onmessage} />
      <button type="button" onclick={onclose}>運転表示を終了（Esc）</button>
    </div>
  </div>
  <div
    class="stage"
    bind:clientWidth={stageWidth}
    bind:clientHeight={stageHeight}
  >
    {#if main && layout && layout.scale > 0}
      <div
        class="frame"
        data-testid="operator-frame"
        style={place(layout.frame)}
      >
        {#if header && layout.header}{@render region(
            header,
            layout.header,
            "header",
          )}{/if}
        {@render region(main, layout.main, "main")}
        {#if footer && layout.footer}{@render region(
            footer,
            layout.footer,
            "footer",
          )}{/if}
      </div>
    {:else if !main}
      <p class="missing" role="status">
        表示する画面が見つかりません。運転表示を終了してください。
      </p>
    {/if}
    <PreviewPopups
      bind:this={popups}
      {project}
      {images}
      {readings}
      {equipmentContext}
      {onmessage}
      {onopentrend}
      {onretiretrend}
    />
  </div>
  {@render overlay?.()}
</div>

<style>
  .operator-view {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    background: #000;
    color: #f8fafc;
    outline: none;
  }
  .operator-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 40px;
    padding: 4px 12px;
    background: #111827;
    border-bottom: 1px solid #1f2937;
    font-size: 14px;
  }
  .operator-bar .current {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .operator-bar .note {
    color: #9ca3af;
    font-size: 12px;
  }
  .operator-bar .actions {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .frame {
    position: absolute;
  }
  .region {
    position: absolute;
  }
  .missing {
    margin: 2rem;
  }
</style>
