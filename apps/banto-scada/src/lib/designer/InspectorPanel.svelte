<script lang="ts">
  import type { Project, ScreenObject } from "../project";
  import type { EditCommand } from "../editor";
  import { symbolUsage } from "../editor";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    element = $bindable<HTMLElement>(),
    visible,
    onclose,
    project,
    selectedIds,
    selected,
    activeDefinition,
    screen,
    drafts,
    properties,
    moveSelection,
    edit,
    openDefinition,
  }: {
    element?: HTMLElement;
    visible: boolean;
    onclose: () => void;
    project: Project;
    selectedIds: string[];
    selected: ScreenObject | undefined;
    activeDefinition: boolean;
    screen: { id: string };
    drafts: ReturnType<typeof createDraftGuard>;
    properties: (event: SubmitEvent) => void;
    moveSelection: (event: SubmitEvent) => void;
    edit: (command: EditCommand) => boolean;
    openDefinition: (id: string) => void;
  } = $props();
</script>

<aside
  class="inspector"
  id="designer-inspector-panel"
  aria-label="プロパティパネル"
  bind:this={element}
  hidden={!visible}
  tabindex="-1"
>
  <div class="panel-header">
    <h2>プロパティ</h2>
    <button
      type="button"
      aria-label="プロパティを隠す"
      title="プロパティを隠す"
      onclick={onclose}>×</button
    >
  </div>
  <div class="panel-content">
    {#if selectedIds.length > 1}
      <p>
        {selectedIds.length} 件選択しています。図形をドラッグするとまとめて移動します。
      </p>
      <form use:drafts.track data-editor-form="move" onsubmit={moveSelection}>
        <div class="fields">
          <label
            >移動量 X<input
              name="dx"
              aria-label="移動量 X"
              type="number"
              step="any"
              required
              value="0"
            /></label
          ><label
            >移動量 Y<input
              name="dy"
              aria-label="移動量 Y"
              type="number"
              step="any"
              required
              value="0"
            /></label
          >
        </div>
        <div class="actions">
          <button type="submit">まとめて移動</button>
        </div>
      </form>
    {:else if selected}
      {#key project.manifest.projectRevision + selected.id}
        <form use:drafts.track data-editor-form="object" onsubmit={properties}>
          <div class="fields">
            {#each "width" in selected ? ["x", "y", "width", "height"] : ["x", "y"] as field}
              <label
                >{field}<input
                  name={field}
                  aria-label={field}
                  type="number"
                  step="any"
                  required
                  min={field === "width" || field === "height"
                    ? 0.001
                    : undefined}
                  value={field === "x"
                    ? selected.x
                    : field === "y"
                      ? selected.y
                      : "width" in selected
                        ? selected[field as "width" | "height"]
                        : 0}
                /></label
              >
            {/each}
            <label
              >色<input
                name="fill"
                aria-label="色"
                type="color"
                value={selected.fill}
              /></label
            >
            {#if selected.shape.type === "polyline"}
              <label
                >頂点（x,y を1行ずつ）<textarea
                  name="points"
                  aria-label="頂点"
                  rows="5"
                  required
                  value={selected.shape.points
                    .map((p) => `${p.x},${p.y}`)
                    .join("\n")}></textarea></label
              >
              <label
                >線幅<input
                  name="strokeWidth"
                  aria-label="線幅"
                  type="number"
                  required
                  min="0.1"
                  max="64"
                  step="any"
                  value={selected.shape.strokeWidth}
                /></label
              >
              <label
                >矢印<select
                  name="arrow"
                  aria-label="矢印"
                  value={selected.shape.arrow}
                  ><option value="none">なし</option><option value="end"
                    >終点</option
                  ></select
                ></label
              >
            {/if}
            {#if selected.shape.type === "text"}<label class="full-width"
                >テキスト<input
                  name="text"
                  aria-label="テキスト"
                  maxlength="1000"
                  value={selected.shape.text}
                /></label
              >
              {#if !activeDefinition}
                <label class="full-width"
                  >表示タグ（外部名）<input
                    name="externalName"
                    aria-label="表示タグ（外部名）"
                    maxlength="1024"
                    placeholder="PLC01.Fast.Tank01.Level"
                    value={selected.shape.binding?.externalName ?? ""}
                  /></label
                >
              {/if}
            {/if}
            {#if selected.shape.type === "symbol"}
              <label class="full-width"
                >参照する Symbol 定義<select
                  name="symbolId"
                  aria-label="参照する Symbol 定義"
                  value={selected.shape.symbolId}
                >
                  {#each project.symbols as definition (definition.id)}
                    <option value={definition.id}
                      >{definition.name} · {symbolUsage(project, definition.id)} 配置</option
                    >
                  {/each}
                </select></label
              >
            {/if}
          </div>
          {#if selected.shape.type === "text" && !activeDefinition}
            <p>
              空欄で静的テキストに戻ります。割り当て中は数値を表示します。Hub
              接続は未実装のため「未接続」と表示します。テキスト欄は割り当て解除後に使います。
            </p>
          {/if}
          {#if selected.shape.type === "symbol"}
            <p>
              参照先を変えても位置・サイズ・色は維持します。共有定義の形状を編集すると、同じ定義を使うすべての配置に反映されます。
            </p>
            <button
              type="button"
              disabled={project.symbols.length >= 100}
              onclick={() =>
                selected &&
                edit({
                  type: "make-symbol-unique",
                  screenId: screen.id,
                  objectId: selected.id,
                })}>定義を複製してこの配置に適用</button
            >
            <button
              type="button"
              onclick={() => {
                if (selected?.shape.type === "symbol")
                  openDefinition(selected.shape.symbolId);
              }}>参照する Symbol 定義を編集</button
            >
          {/if}
          <div class="actions">
            <button type="submit">変更を適用</button>
          </div>
        </form>
      {/key}
    {:else}<p>
        図形をクリック、または一覧から選んでください。図形はドラッグして移動できます。
      </p>{/if}
  </div>
</aside>

<style>
  .inspector {
    min-height: 0;
    overflow: auto;
    border-left: 1px solid var(--banto-border);
    background: var(--banto-surface);
  }
  .inspector[hidden] {
    display: none;
  }
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--banto-border);
  }
  h2 {
    font-size: 13px;
    margin: 0;
  }
  .panel-header button {
    width: 28px;
    margin: 0;
    padding: 2px;
    font-size: 20px;
    text-align: center;
  }
  .panel-content {
    padding: 14px;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-top: 8px;
  }
  .fields label {
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  .fields input,
  .fields textarea,
  .fields select {
    display: block;
    width: 100%;
    min-height: 36px;
    margin-top: 6px;
    background: var(--banto-bg);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    padding: 6px;
    border-radius: 4px;
  }
  .full-width,
  .fields label:has(textarea),
  .fields label:has(input[name="text"]) {
    grid-column: 1 / -1;
  }
  p {
    font-size: 13px;
    line-height: 1.8;
    color: var(--banto-text-muted);
    overflow-wrap: anywhere;
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
    border-radius: 4px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
    align-items: center;
  }
  .actions button {
    width: auto;
    white-space: normal;
  }
  @media (min-width: 701px) and (max-width: 1099px) {
    .inspector {
      grid-column: 2;
      border-left: 0;
      border-top: 1px solid var(--banto-border);
    }
  }
  @media (min-width: 701px) and (max-width: 1099px) {
    :global(main:not(.sidebar-visible)) .inspector {
      grid-column: 1;
    }
  }
  @media (max-width: 700px) {
    .inspector {
      border-left: 0;
      border-top: 1px solid var(--banto-border);
    }
  }
</style>
