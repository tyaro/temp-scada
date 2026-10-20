<script module lang="ts">
  import type { Screen, SymbolDefinition, ScreenObject } from "../project";
  import type { layerTree } from "./layer-tree";
  import type { LayerDrag, LayerInsertion } from "./layer-drag";
  import type { FolderOperation } from "./FolderDialog.svelte";
  /** View contract. The controller owns browsing state; App owns selection and edits. */
  export interface LayerTreeBindings {
    readonly screen: Screen | SymbolDefinition;
    readonly symbols: SymbolDefinition[];
    readonly folderScope: string;
    layerQuery: string;
    layersExpanded: boolean;
    readonly layerDrag: LayerDrag | null;
    readonly layerDragGuide: LayerDrag | null;
    readonly layerDropTarget: string | null;
    readonly layerDropTargetError: string | null;
    readonly layerInsertion: LayerInsertion | null;
    readonly layerDragDescription: string;
    readonly selectedIds: readonly string[];
    readonly hiddenSelectionCount: number;
    readonly editBlocked: boolean;
    readonly menuBlocked: boolean;
    readonly layerTreeView: ReturnType<typeof layerTree>;
    readonly visibleLayers: readonly ScreenObject[];
    readonly layerDragClickUntil: number;
    hoverLayerDrop(target: string | null): void;
    hoverLayerInsertion(target: LayerInsertion | null): void;
    canInsertLayer(target: LayerInsertion): boolean;
    insertLayer(event: DragEvent, target: LayerInsertion): void;
    acceptsLayerDrag(event: DragEvent): boolean;
    dropLayer(event: DragEvent, destination: string): void;
    endLayerDrag(): void;
    openFolderRequest(
      kind: FolderOperation,
      folderId?: string,
      origin?: HTMLElement,
    ): void;
    toggleFolder(id: string): void;
    showFolderMenu(id: string, origin: HTMLElement): void;
    folderKey(event: KeyboardEvent, id: string): void;
    beginFolderDrag(event: DragEvent, id: string): void;
    beginLayerDrag(event: DragEvent, id: string): void;
    objectLabel(object: ScreenObject): string;
    layerClick(event: MouseEvent, id: string): void;
    layerContext(id: string, origin: HTMLElement): void;
    layerContextKey(event: KeyboardEvent, id: string): void;
    toggleObjectVisibility(id: string): void;
    toggleObjectLock(id: string): void;
  }
</script>

<script lang="ts">
  import TreeSection from "./TreeSection.svelte";
  import ObjectIcon from "./ObjectIcon.svelte";
  import { folderPath } from "./layer-tree";
  import {
    layerDropSurface,
    layerDragError,
    layerDropError,
  } from "./layer-drag";
  let { tree }: { tree: LayerTreeBindings } = $props();
</script>

<div
  class="layer-browser"
  use:layerDropSurface={{
    accepts: tree.acceptsLayerDrag,
    active: () =>
      !!tree.layerDrag &&
      !tree.editBlocked &&
      !layerDragError(tree.screen, tree.folderScope, tree.layerDrag),
    allowed: (destination) =>
      !!tree.layerDrag &&
      !layerDropError(
        tree.screen,
        tree.folderScope,
        tree.layerDrag,
        destination,
      ),
    hover: tree.hoverLayerDrop,
    drop: tree.dropLayer,
    end: tree.endLayerDrag,
    insertion: {
      hover: tree.hoverLayerInsertion,
      allowed: tree.canInsertLayer,
      drop: tree.insertLayer,
    },
  }}
>
  <div class="layer-search-row">
    <input
      class="layer-search"
      type="search"
      aria-label="レイヤーを検索"
      placeholder="検索"
      bind:value={tree.layerQuery}
      oninput={() => (tree.layersExpanded = true)}
    />
    <button
      data-create-layer-folder
      title="ルートにフォルダーを作成"
      aria-label="ルートにフォルダーを作成"
      disabled={tree.editBlocked || tree.screen.folders.length >= 256}
      onclick={(event) =>
        tree.openFolderRequest("create", undefined, event.currentTarget)}
      ><svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
        ><path d="M3 7V5h7l2 3h9v12H3V7M12 11v6M9 14h6" /></svg
      ></button
    >
  </div>
  {#if tree.layerQuery.trim()}<p class="layer-query-status">
      検索結果を展開中 <button onclick={() => (tree.layerQuery = "")}
        >検索を解除</button
      >
    </p>{/if}
  {#if tree.layerDragGuide}
    <div class="layer-drag-guide">
      {#if tree.layerDragGuide.kind === "folder"}
        <p class="layer-caption" title={tree.layerDragDescription}>
          フォルダー「{tree.layerDragGuide.name}」と配下を移動
        </p>
        <p class="layer-caption">
          配置 {tree.layerDragGuide.count} 件・非表示 {tree.layerDragGuide
            .hidden}
          件
        </p>
        <p
          class="layer-caption"
          role="status"
          title={tree.layerDragDescription}
        >
          {tree.layerInsertion
            ? tree.layerDragDescription
            : (tree.layerDropTargetError ??
              (tree.layerDropTarget === null
                ? "フォルダーへドロップ"
                : tree.layerDropTarget
                  ? `${folderPath(tree.screen.folders, tree.layerDropTarget)} 直下へ`
                  : "ルートへ移動"))}
        </p>
      {:else}
        <p
          class="layer-caption"
          role="status"
          title={tree.layerDragDescription}
        >
          {tree.layerDragDescription}
        </p>
      {/if}
      <div
        class="layer-root-drop"
        class:drop-hover={tree.layerDropTarget === "" &&
          !tree.layerDropTargetError}
        data-layer-drop-folder=""
      >
        {tree.layerDragGuide.kind === "folder"
          ? "ルートへ移動（親フォルダーなし）"
          : "フォルダーから外す（ルートへ）"}
      </div>
    </div>
  {:else}<p class="layer-caption">
      {tree.selectedIds.length} 件選択{#if tree.hiddenSelectionCount}（非表示 {tree.hiddenSelectionCount}
        件）{/if} · {tree.screen.folders.length
        ? "所属と描画順は独立"
        : "下の配置ほど前面"}
    </p>{/if}
  <TreeSection
    label={tree.screen.name}
    count={tree.screen.objects.length}
    bind:open={tree.layersExpanded}
  >
    {#if tree.selectedIds.some((id) => !tree.visibleLayers.some((object) => object.id === id))}
      <p class="hint" role="status">
        選択中の配置は検索条件外です。選択とプロパティは保持しています。
      </p>
    {/if}
    <nav aria-label="図形一覧">
      {#each tree.layerTreeView.rows as row (row.kind === "folder" ? row.folder.id : row.object.id)}
        {#if row.kind === "folder"}
          <div
            class="layer-folder"
            data-layer-order-kind="folder"
            data-layer-order-id={row.folder.id}
            class:insert-before={tree.layerInsertion?.kind === "folder" &&
              tree.layerInsertion.id === row.folder.id &&
              tree.layerInsertion.position === "before" &&
              !tree.layerDropTargetError}
            class:insert-after={tree.layerInsertion?.kind === "folder" &&
              tree.layerInsertion.id === row.folder.id &&
              tree.layerInsertion.position === "after" &&
              !tree.layerDropTargetError}
            class:drop-hover={!!tree.layerDrag &&
              !tree.layerDropTargetError &&
              tree.layerDropTarget === row.folder.id}
            data-layer-drop-folder={row.folder.id}
            style:margin-left={`${row.depth * 10}px`}
          >
            <button
              data-layer-folder={row.folder.id}
              aria-expanded={row.open}
              title={folderPath(tree.screen.folders, row.folder.id)}
              onclick={(event) => {
                if (
                  event.detail &&
                  performance.now() < tree.layerDragClickUntil
                )
                  return;
                tree.toggleFolder(row.folder.id);
              }}
              oncontextmenu={(event) => {
                event.preventDefault();
                tree.showFolderMenu(row.folder.id, event.currentTarget);
              }}
              onkeydown={(event) => tree.folderKey(event, row.folder.id)}
            >
              <span class="folder-chevron" aria-hidden="true"
                >{row.open ? "⌄" : "›"}</span
              >
              <span
                class="folder-drag-source"
                role="img"
                aria-label={row.folder.name}
                draggable={!tree.editBlocked}
                data-folder-drag-source={row.folder.id}
                ondragstart={(event) =>
                  tree.beginFolderDrag(event, row.folder.id)}
              >
                <svg
                  width="19"
                  height="19"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  aria-hidden="true"
                  ><path
                    d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7h18"
                  /></svg
                >
                <span class="folder-name">{row.folder.name}</span></span
              >
            </button>
            <button
              class="folder-more"
              data-layer-folder={row.folder.id}
              aria-label={`フォルダー操作：${row.folder.name}`}
              aria-haspopup="menu"
              onclick={(event) =>
                tree.showFolderMenu(row.folder.id, event.currentTarget)}
              onkeydown={(event) => tree.folderKey(event, row.folder.id)}
              >⋮</button
            >
          </div>
        {:else}
          {@const object = row.object}
          {@const members = row.group
            ? tree.screen.objects.filter((item) =>
                row.group!.memberIds.includes(item.id),
              )
            : [object]}
          {@const locked = members.some((item) => item.locked)}
          {@const hidden = members.some((item) => item.visible === false)}
          {@const mixedVisibility =
            hidden && members.some((item) => item.visible !== false)}
          {@const mixedLock = locked && members.some((item) => !item.locked)}
          {@const label = row.group
            ? `${row.group.name ?? "グループ"} · ${members.length} 配置`
            : tree.objectLabel(object)}

          <div
            class="layer-entry"
            data-layer-order-kind="object"
            data-layer-order-id={object.id}
            class:insert-before={tree.layerInsertion?.kind === "object" &&
              tree.layerInsertion.id === object.id &&
              tree.layerInsertion.position === "before" &&
              !tree.layerDropTargetError}
            class:insert-after={tree.layerInsertion?.kind === "object" &&
              tree.layerInsertion.id === object.id &&
              tree.layerInsertion.position === "after" &&
              !tree.layerDropTargetError}
            style:margin-left={`${row.depth * 10}px`}
            class:hidden-placement={hidden}
          >
            <button
              class:active={tree.selectedIds.includes(object.id)}
              aria-pressed={tree.selectedIds.includes(object.id)}
              data-layer-id={object.id}
              data-layer-group={row.group?.id}
              draggable={!tree.editBlocked}
              ondragstart={(event) => tree.beginLayerDrag(event, object.id)}
              title={`${label}${row.group ? "\n" + members.map((item) => tree.objectLabel(item)).join("\n") : ""}
${object.shape.type} · ${object.order}
${object.id}`}
              onclick={(event) => tree.layerClick(event, object.id)}
              oncontextmenu={(event) => {
                event.preventDefault();
                tree.layerContext(object.id, event.currentTarget);
              }}
              onkeydown={(event) => tree.layerContextKey(event, object.id)}
              >{#if row.group}<svg
                  width="19"
                  height="19"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  aria-hidden="true"
                  ><path d="M2 2h20v20H2zM6 6h5v5H6zM13 13h5v5h-5z" /></svg
                >{:else}<ObjectIcon
                  {object}
                  definition={object.shape.type === "symbol"
                    ? tree.symbols.find(
                        (d) =>
                          object.shape.type === "symbol" &&
                          d.id === object.shape.symbolId,
                      )
                    : undefined}
                />{/if}<span>{label}</span></button
            >
            <button
              class="layer-visible"
              aria-label={`${mixedVisibility ? "一部非表示・再表示" : hidden ? "再表示" : "非表示"}：${label}`}
              aria-pressed={!hidden}
              title={hidden
                ? "図面に再表示"
                : "図面から非表示（表示プレビューにも反映）"}
              disabled={tree.menuBlocked}
              onclick={() => tree.toggleObjectVisibility(object.id)}
              ><svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                aria-hidden="true"
                ><path
                  d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"
                /><circle cx="12" cy="12" r="3" />{#if hidden}<path
                    d="M3 3l18 18"
                  />{/if}</svg
              ></button
            >
            <button
              class="layer-lock"
              class:locked
              aria-label={`${mixedLock ? "一部ロック・解除" : locked ? "ロック解除" : "ロック"}：${label}`}
              aria-pressed={locked}
              title={locked
                ? "編集ロックを解除"
                : "配置の直接編集をロック（共有定義の変更は反映）"}
              disabled={tree.menuBlocked}
              onclick={() => tree.toggleObjectLock(object.id)}
              ><svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                aria-hidden="true"
                ><rect x="5" y="10" width="14" height="11" rx="2" /><path
                  d={locked
                    ? "M8 10V7a4 4 0 0 1 8 0v3"
                    : "M8 10V7a4 4 0 0 1 8 0"}
                /><path d="M12 14v4" /></svg
              ></button
            >
            <button
              class="layer-more"
              aria-label={`操作：${label}`}
              title={`${label} の操作`}
              aria-haspopup="menu"
              onclick={(event) =>
                tree.layerContext(object.id, event.currentTarget)}
              onkeydown={(event) => tree.layerContextKey(event, object.id)}
              >⋮</button
            >
          </div>
        {/if}
      {/each}
    </nav>
    {#if !tree.layerTreeView.rows.length}<p class="hint">
        {tree.layerQuery.trim()
          ? "一致する配置はありません。"
          : "配置はありません。"}
      </p>{/if}
  </TreeSection>
</div>

<style>
  .layer-drag-guide .layer-caption[role="status"] {
    white-space: normal;
    line-height: 1.4;
    height: 4.2em;
    overflow: hidden;
    text-overflow: clip;
  }
  .layer-folder,
  .layer-entry {
    position: relative;
  }
  .insert-before::before,
  .insert-after::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--banto-primary);
    pointer-events: none;
    z-index: 1;
  }
  .insert-before::before {
    top: 0;
  }
  .insert-after::after {
    bottom: 0;
  }

  nav[aria-label="図形一覧"] {
    overflow-x: auto;
  }
  .layer-search-row {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-bottom: 6px;
  }
  .layer-search-row .layer-search {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .layer-search-row > button {
    display: grid;
    place-items: center;
    width: 30px;
    height: 32px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--banto-primary);
  }
  .layer-query-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    font-size: 11px;
    color: var(--banto-text-muted);
  }
  .layer-query-status button {
    padding: 2px 4px;
    margin: 0;
    border: 0;
    background: transparent;
    color: var(--banto-primary);
    font-size: inherit;
  }
  .layer-drag-guide {
    position: sticky;
    top: -10px;
    z-index: 2;
    background: var(--banto-surface);
    padding: 2px 0 6px;
  }
  .layer-drag-guide .layer-caption {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .layer-root-drop {
    padding: 9px 6px;
    border: 1px dashed var(--banto-border);
    color: var(--banto-text-muted);
    font-size: 12px;
  }
  .layer-root-drop.drop-hover,
  .layer-folder.drop-hover {
    background: color-mix(
      in srgb,
      var(--banto-primary) 12%,
      var(--banto-surface)
    );
    outline: 2px solid var(--banto-primary);
    outline-offset: -2px;
  }
  .layer-folder {
    position: relative;
    min-width: 150px;
  }
  .layer-folder > button:first-child {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 36px;
    padding: 7px 28px 7px 0;
    margin: 0;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--banto-text);
    text-align: left;
    font-size: 12px;
    font-weight: 600;
  }
  .layer-folder > button:first-child:hover {
    background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
  }
  .layer-folder svg,
  .folder-chevron {
    flex-shrink: 0;
    color: var(--banto-text-muted);
  }
  .folder-chevron {
    width: 12px;
    text-align: center;
  }
  .folder-drag-source {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    flex: 1;
    cursor: grab;
  }
  .folder-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .folder-more {
    position: absolute;
    right: 2px;
    top: 3px;
    width: 24px;
    height: 28px;
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
    opacity: 0;
  }
  .layer-folder:hover .folder-more,
  .layer-folder:focus-within .folder-more {
    opacity: 1;
  }
  .layer-folder button:focus-visible {
    outline: none;
    box-shadow: inset var(--banto-focus-ring);
  }
  @media (hover: none) {
    .folder-more {
      opacity: 1;
    }
  }
  .layer-search {
    width: 100%;
    margin-bottom: 6px;
    padding: 8px 10px;
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    background: var(--banto-surface);
    color: var(--banto-text);
    font: inherit;
    font-size: 12px;
  }
  .layer-search:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .layer-entry {
    position: relative;
  }
  .layer-entry > button:first-child {
    padding-right: 78px;
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    min-height: 36px;
    width: 100%;
    overflow-wrap: anywhere;
  }
  .layer-entry > button:first-child span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .layer-entry.hidden-placement > button:first-child {
    opacity: 0.6;
  }
  .layer-entry .layer-visible {
    display: grid;
    place-items: center;
    position: absolute;
    right: 52px;
    top: 4px;
    width: 24px;
    min-height: 28px;
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
  }
  .layer-entry .layer-lock {
    display: grid;
    place-items: center;
    position: absolute;
    right: 26px;
    top: 4px;
    width: 24px;
    min-height: 28px;
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
    font-size: 12px;
    opacity: 0;
  }
  .layer-entry .layer-lock.locked,
  .layer-entry:hover .layer-lock,
  .layer-entry:focus-within .layer-lock {
    opacity: 1;
  }
  .layer-entry .layer-more {
    position: absolute;
    right: 3px;
    top: 3px;
    border: 0;
    background: transparent;
    width: 22px;
    height: 28px;
    padding: 0;
    margin: 0;
    opacity: 0;
  }
  .layer-entry:hover .layer-more,
  .layer-entry:focus-within .layer-more {
    opacity: 1;
  }
  @media (hover: none) {
    .layer-entry .layer-lock,
    .layer-entry .layer-more {
      opacity: 1;
    }
  }
  .layer-entry > button:first-child {
    margin: 0;
    padding: 7px 26px 7px 8px;
    min-height: 36px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--banto-text);
  }
  .layer-entry > button:first-child {
    padding-right: 78px;
  }
  .layer-entry > button:first-child:hover {
    background: color-mix(in srgb, #14b8a6 8%, transparent);
  }
  .layer-entry > button:first-child.active {
    background: color-mix(in srgb, #14b8a6 18%, transparent);
  }
  .layer-entry > button:focus-visible {
    box-shadow: inset var(--banto-focus-ring);
  }
  .layer-caption {
    margin: 4px 2px 10px;
    font-size: 11px;
  }
  button:focus-visible,
  input:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  p {
    font-size: 13px;
    line-height: 1.8;
    color: var(--banto-text-muted);
  }
  button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 9px 10px;
    margin: 8px 0;
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .active {
    border-color: var(--banto-primary);
    color: var(--banto-primary);
  }
  .hint {
    margin-top: 12px;
  }
</style>
