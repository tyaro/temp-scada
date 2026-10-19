<script lang="ts">
  import TagPicker from "./TagPicker.svelte";
  import {
    sampleCatalog,
    numericTag,
    type CatalogTag,
    type TagCatalog,
  } from "./tag-catalog";
  import {
    objectFormValues,
    parseNumericProperty,
    type NumericProperty,
    type NumericTarget,
  } from "./numeric-properties";
  import type { Project, ScreenObject } from "../project";
  import type { EditCommand } from "../editor";
  import { symbolUsage } from "../editor";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    element = $bindable<HTMLElement>(),
    visible,
    generation,
    commitNumber,
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
    generation: number;
    commitNumber: (
      target: NumericTarget,
      field: NumericProperty,
      value: number,
      input: HTMLInputElement,
    ) => string | null;
    onclose: () => void;
    project: Project;
    selectedIds: string[];
    selected: ScreenObject | undefined;
    activeDefinition: boolean;
    screen: { id: string; name: string };
    drafts: ReturnType<typeof createDraftGuard>;
    properties: (event: SubmitEvent) => void;
    moveSelection: (event: SubmitEvent) => void;
    edit: (command: EditCommand) => boolean;
    openDefinition: (id: string) => void;
  } = $props();
  let tagInput = $state<HTMLInputElement>();
  let pickerOpen = $state(false);
  export function isTagPickerOpen() {
    return pickerOpen;
  }
  let pickerRequest = $state.raw<{
    key: string;
    input: HTMLInputElement;
    catalog: TagCatalog;
    revision: string;
    label: string;
  } | null>(null);
  const pickerKey = $derived(
    `${generation}:${screen.id}:${selected?.id ?? ""}:${visible}:${activeDefinition}`,
  );
  $effect(() => {
    if (pickerOpen && pickerRequest?.key !== pickerKey) pickerOpen = false;
  });
  function openTagPicker() {
    if (
      !tagInput ||
      !selected ||
      selected.shape.type !== "text" ||
      activeDefinition ||
      !visible ||
      drafts.pending
    )
      return;
    pickerRequest = {
      key: pickerKey,
      input: tagInput,
      catalog: sampleCatalog,
      revision: sampleCatalog.revision,
      label: `${screen.name} ／ Text · ${selected.order} ／ 表示タグ`,
    };
    pickerOpen = true;
  }
  function chooseTag(tag: CatalogTag, revision: string) {
    const request = pickerRequest;
    if (
      selected?.shape.type !== "text" ||
      activeDefinition ||
      !visible ||
      drafts.pending ||
      !pickerOpen ||
      !request ||
      request.key !== pickerKey ||
      request.input !== tagInput ||
      !request.input.isConnected ||
      request.catalog !== sampleCatalog ||
      request.revision !== revision ||
      sampleCatalog.revision !== revision ||
      !numericTag(tag) ||
      !sampleCatalog.tags.some(
        (candidate) =>
          candidate.id === tag.id &&
          candidate.externalName === tag.externalName &&
          numericTag(candidate),
      )
    ) {
      pickerOpen = false;
      return;
    }
    request.input.value = tag.externalName;
    request.input.dispatchEvent(new Event("input", { bubbles: true }));
    pickerOpen = false;
  }
  let numericErrors = $state<Record<string, string>>({});
  const targets = new WeakMap<HTMLInputElement, NumericTarget>();
  const composing = new Set<HTMLInputElement>();
  const blurred = new WeakSet<HTMLInputElement>();
  function focusNumber(event: FocusEvent) {
    const input = event.currentTarget as HTMLInputElement;
    if (selected)
      targets.set(input, {
        generation,
        screenId: screen.id,
        objectId: selected.id,
        definition: activeDefinition,
      });
  }
  function clearNumber(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    input.setCustomValidity("");
    numericErrors = { ...numericErrors, [input.name]: "" };
  }
  function commitInput(input: HTMLInputElement) {
    if (composing.has(input) || !input.isConnected || drafts.pending) return;
    const target = targets.get(input);
    if (
      !target ||
      target.generation !== generation ||
      target.screenId !== screen.id ||
      target.objectId !== selected?.id ||
      target.definition !== activeDefinition
    )
      return;
    try {
      const value = parseNumericProperty(input.value);
      const error = commitNumber(
        target,
        input.name as NumericProperty,
        value,
        input,
      );
      if (error) throw new Error(error);
      input.setCustomValidity("");
      numericErrors = { ...numericErrors, [input.name]: "" };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "数値を確定できません。";
      input.setCustomValidity(message);
      numericErrors = { ...numericErrors, [input.name]: message };
    }
  }
  export function commitFocusedNumber(): boolean {
    if (composing.size) return false;
    const input = document.activeElement;
    if (
      input instanceof HTMLInputElement &&
      element?.contains(input) &&
      targets.has(input)
    )
      commitInput(input);
    return true;
  }
  function numberKey(event: KeyboardEvent) {
    const input = event.currentTarget as HTMLInputElement;
    if (event.isComposing || composing.has(input) || event.keyCode === 229)
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      commitInput(input);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      commitInput(input);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (selected)
        input.value =
          objectFormValues(selected, activeDefinition)[input.name] ?? "";
      clearNumber(event);
      drafts.acceptField(input);
    }
  }
  function blurNumber(event: FocusEvent) {
    const input = event.currentTarget as HTMLInputElement;
    if (composing.has(input)) blurred.add(input);
    else commitInput(input);
  }
  function compositionStart(event: CompositionEvent) {
    composing.add(event.currentTarget as HTMLInputElement);
  }
  function compositionEnd(event: CompositionEvent) {
    const input = event.currentTarget as HTMLInputElement;
    composing.delete(input);
    if (blurred.has(input)) {
      blurred.delete(input);
      commitInput(input);
    }
  }
  const numericIdentity = $derived(
    `${generation}:${screen.id}:${selected?.id ?? ""}`,
  );
  $effect(() => {
    numericIdentity;
    numericErrors = {};
    composing.clear();
  });
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
  {#if selected}<div class="inspector-subject">
      <strong
        >{selected.shape.type === "symbol"
          ? (project.symbols.find(
              (d) =>
                selected.shape.type === "symbol" &&
                d.id === selected.shape.symbolId,
            )?.name ?? "Symbol")
          : selected.shape.type}</strong
      ><small>配置 {selected.order}</small>
    </div>{/if}
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
      {#key `${generation}:${screen.id}:${selected.id}`}
        <form
          use:drafts.track={objectFormValues(selected, activeDefinition)}
          data-editor-form="object"
          onreset={() => (numericErrors = {})}
          onsubmit={(event) => {
            if (composing.size) event.preventDefault();
            else properties(event);
          }}
        >
          <p class="numeric-hint">Enter・フォーカス移動で確定 · Escで取消</p>
          <div class="fields">
            {#each "width" in selected ? ["x", "y", "width", "height"] : ["x", "y"] as field}
              <label
                >{field}<input
                  name={field}
                  aria-label={field}
                  type="text"
                  inputmode="decimal"
                  required
                  aria-invalid={numericErrors[field] ? "true" : undefined}
                  aria-describedby={numericErrors[field]
                    ? `numeric-${field}-error`
                    : undefined}
                  onfocus={focusNumber}
                  oninput={clearNumber}
                  onkeydown={numberKey}
                  onblur={blurNumber}
                  oncompositionstart={compositionStart}
                  oncompositionend={compositionEnd}
                />{#if numericErrors[field]}<span
                    class="field-error"
                    id={`numeric-${field}-error`}
                    role="alert">{numericErrors[field]}</span
                  >{/if}</label
              >
            {/each}
            <label>色<input name="fill" aria-label="色" type="color" /></label>
            {#if selected.shape.type === "polyline"}
              <label
                >頂点（x,y を1行ずつ）<textarea
                  name="points"
                  aria-label="頂点"
                  rows="5"
                  required></textarea></label
              >
              <label
                >線幅<input
                  name="strokeWidth"
                  aria-label="線幅"
                  type="text"
                  inputmode="decimal"
                  required
                  aria-invalid={numericErrors.strokeWidth ? "true" : undefined}
                  aria-describedby={numericErrors.strokeWidth
                    ? "numeric-strokeWidth-error"
                    : undefined}
                  onfocus={focusNumber}
                  oninput={clearNumber}
                  onkeydown={numberKey}
                  onblur={blurNumber}
                  oncompositionstart={compositionStart}
                  oncompositionend={compositionEnd}
                />{#if numericErrors.strokeWidth}<span
                    class="field-error"
                    id="numeric-strokeWidth-error"
                    role="alert">{numericErrors.strokeWidth}</span
                  >{/if}</label
              >
              <label
                >矢印<select name="arrow" aria-label="矢印"
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
                /></label
              >
              {#if !activeDefinition}
                <div class="full-width tag-binding">
                  <label
                    >表示タグ（外部名）<input
                      bind:this={tagInput}
                      name="externalName"
                      aria-label="表示タグ（外部名）"
                      maxlength="1024"
                      placeholder="PLC01.Fast.Tank01.Level"
                    /></label
                  >
                  <button
                    type="button"
                    aria-label="タグを選択"
                    title="サンプル候補からタグを選択"
                    onclick={openTagPicker}>…</button
                  >
                </div>
                <p class="full-width tag-note">
                  Hub未接続のため、手入力した外部名の存在・型は未確認です。
                </p>
              {/if}
            {/if}
            {#if selected.shape.type === "symbol"}
              <label class="full-width"
                >参照する Symbol 定義<select
                  name="symbolId"
                  aria-label="参照する Symbol 定義"
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

<TagPicker
  open={pickerOpen}
  catalog={sampleCatalog}
  targetLabel={pickerRequest?.label ?? ""}
  onclose={() => (pickerOpen = false)}
  onchoose={chooseTag}
/>

<style>
  .tag-binding {
    display: flex;
    align-items: flex-end;
    gap: 6px;
  }
  .tag-binding label {
    flex: 1;
    min-width: 0;
  }
  .tag-binding button {
    flex: 0 0 32px;
    height: 34px;
    padding: 0;
  }
  .tag-note {
    font-size: 11px;
    color: var(--banto-text-muted);
    margin: 0;
  }
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
  .field-error {
    display: block;
    color: var(--banto-danger, #b42318);
    margin-top: 5px;
    overflow-wrap: anywhere;
  }
  .fields input[aria-invalid="true"] {
    border-color: var(--banto-danger, #b42318);
  }
  .inspector-subject {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 14px 0;
    overflow-wrap: anywhere;
    font-size: 13px;
  }
  .inspector-subject small {
    color: var(--banto-text-muted);
    font-size: 10px;
  }
  .numeric-hint {
    font-size: 12px;
  }
  .fields input[inputmode="decimal"] {
    min-height: 30px;
    margin-top: 4px;
    padding: 4px 2px;
    border: 0;
    border-bottom: 1px solid var(--banto-border);
    border-radius: 0;
    background: transparent;
  }
  .fields input[inputmode="decimal"][aria-invalid="true"] {
    border-bottom-color: var(--banto-danger);
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
