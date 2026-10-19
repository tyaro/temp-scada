<script lang="ts">
  import { placementLabel } from "../placement-label";
  import ShapePaint from "./ShapePaint.svelte";
  import SelectionColor from "./SelectionColor.svelte";
  import SelectionOutline from "./SelectionOutline.svelte";
  import SelectionLine from "./SelectionLine.svelte";
  import SymbolColorMode from "./SymbolColorMode.svelte";
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
    selectionLocked,
    hiddenSelectionCount,
    ontogglevisibility,
    ontogglelock,
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
    selectionLocked: boolean;
    hiddenSelectionCount: number;
    ontogglevisibility: (id: string) => void;
    ontogglelock: (id: string) => void;
    activeDefinition: boolean;
    screen: { id: string; name: string; objects: ScreenObject[] };
    drafts: ReturnType<typeof createDraftGuard>;
    properties: (event: SubmitEvent) => void;
    moveSelection: (event: SubmitEvent) => void;
    edit: (command: EditCommand) => boolean;
    openDefinition: (id: string) => void;
  } = $props();
  const selectedColors = $derived(
    new Set(
      screen.objects
        .filter((object) => selectedIds.includes(object.id))
        .flatMap((object) => {
          if (
            object.shape.type === "rectangle" ||
            object.shape.type === "ellipse"
          )
            return [
              ...(object.shape.paint.fillEnabled
                ? [object.fill.toLowerCase()]
                : []),
              ...(object.shape.paint.stroke
                ? [object.shape.paint.stroke.color.toLowerCase()]
                : []),
            ];
          return [object.fill.toLowerCase()];
        }),
    ),
  );
  const paintDisabledCount = $derived(
    screen.objects.filter(
      (object) =>
        selectedIds.includes(object.id) &&
        (object.shape.type === "rectangle" ||
          object.shape.type === "ellipse") &&
        !object.shape.paint.fillEnabled &&
        !object.shape.paint.stroke,
    ).length,
  );
  const definitionColorCount = $derived(
    screen.objects.filter(
      (object) =>
        selectedIds.includes(object.id) &&
        object.shape.type === "symbol" &&
        object.shape.colorMode === "definition",
    ).length,
  );
  const commonColor = $derived(
    selectedColors.size === 1 ? [...selectedColors][0] : null,
  );
  let textError = $state("");
  $effect(() => {
    selected?.id;
    textError = "";
  });
  function pasteText(event: ClipboardEvent) {
    if (
      /[\r\n\u2028\u2029]/u.test(
        event.clipboardData?.getData("text/plain") ?? "",
      )
    ) {
      event.preventDefault();
      textError =
        "1行の文字列を入力してください。改行を含む貼り付けはできません。";
    }
  }
  let tagInput = $state<HTMLInputElement>();
  let pickerOpen = $state(false);
  export function isTagPickerOpen() {
    return pickerOpen;
  }
  export function focusName() {
    const input = element?.querySelector<HTMLInputElement>(
      'form[data-editor-form="object"] input[name="name"]',
    );
    input?.focus();
    input?.select();
  }
  let pickerRequest = $state.raw<{
    key: string;
    input: HTMLInputElement;
    catalog: TagCatalog;
    revision: string;
    label: string;
  } | null>(null);
  const pickerKey = $derived(
    `${generation}:${screen.id}:${selected?.id ?? ""}:${!!selected?.locked}:${visible}:${activeDefinition}`,
  );
  $effect(() => {
    if (pickerOpen && pickerRequest?.key !== pickerKey) pickerOpen = false;
  });
  function openTagPicker() {
    if (
      !tagInput ||
      !selected ||
      selected.locked ||
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
      label: `${screen.name} ／ ${selected.name ? `${selected.name}（Text · ${selected.order}）` : `Text · ${selected.order}`} ／ 表示タグ`,
    };
    pickerOpen = true;
  }
  function chooseTag(tag: CatalogTag, revision: string) {
    const request = pickerRequest;
    if (
      selected?.shape.type !== "text" ||
      selected.locked ||
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
      <strong title={placementLabel(selected, project.symbols)}
        >{placementLabel(selected, project.symbols)}</strong
      >
      <small
        >{activeDefinition ? "共有定義内" : "画面内"} · {selected.shape.type} · 配置
        {selected.order}</small
      >
    </div>{/if}
  <div class="panel-content">
    {#if hiddenSelectionCount}
      <p role="status">
        選択中 {selectedIds.length} 件のうち {hiddenSelectionCount} 件が非表示です。表示プレビューにも反映されます。
      </p>
      {#if selected?.visible === false}<button
          type="button"
          onclick={() => ontogglevisibility(selected.id)}>配置を再表示</button
        >{/if}
    {/if}
    {#if selectionLocked}
      <p class="lock-status" role="status">
        ロック中の配置を含むため、プロパティは閲覧専用です。共有定義の変更は反映されます。
      </p>
      {#if selected?.locked}<button
          type="button"
          onclick={() => ontogglelock(selected.id)}>ロックを解除</button
        >{/if}
      {#if selected?.locked && selected.shape.type === "symbol"}
        <button
          type="button"
          onclick={() => {
            if (selected?.shape.type === "symbol")
              openDefinition(selected.shape.symbolId);
          }}>共有定義を確認・編集</button
        >
      {/if}
    {/if}
    {#if selectedIds.length > 1}
      <p>
        {selectedIds.length} 件選択しています。図形をドラッグするとまとめて移動します。
      </p>
      <form use:drafts.track data-editor-form="move" onsubmit={moveSelection}>
        <fieldset disabled={selectionLocked}>
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
        </fieldset>
      </form>
      {#key `${generation}:${screen.id}:${activeDefinition}:${[...selectedIds].sort().join(",")}`}
        <SelectionColor
          current={commonColor}
          {definitionColorCount}
          imageCount={screen.objects.filter(
            (o) => selectedIds.includes(o.id) && o.shape.type === "image",
          ).length}
          {paintDisabledCount}
          count={selectedIds.length}
          hiddenCount={hiddenSelectionCount}
          locked={selectionLocked}
          definition={activeDefinition}
          targetKey={`${generation}:${screen.id}:${activeDefinition}`}
          objectIds={selectedIds}
          {drafts}
          onsubmit={properties}
        />
        <SelectionOutline
          objects={screen.objects.filter((object) =>
            selectedIds.includes(object.id),
          )}
          hiddenCount={hiddenSelectionCount}
          locked={selectionLocked}
          definition={activeDefinition}
          targetKey={`${generation}:${screen.id}:${activeDefinition}`}
          objectIds={selectedIds}
          {drafts}
          onsubmit={properties}
        />
        <SelectionLine
          objects={screen.objects.filter((object) =>
            selectedIds.includes(object.id),
          )}
          hiddenCount={hiddenSelectionCount}
          locked={selectionLocked}
          definition={activeDefinition}
          targetKey={`${generation}:${screen.id}:${activeDefinition}`}
          objectIds={selectedIds}
          {drafts}
          onsubmit={properties}
        />
      {/key}
    {:else if selected}
      {#key `${generation}:${screen.id}:${selected.id}`}
        {#if selected.shape.type === "rectangle" || selected.shape.type === "ellipse"}
          <ShapePaint
            paint={selected.shape.paint}
            objectId={selected.id}
            targetKey={`${generation}:${screen.id}:${activeDefinition}`}
            locked={selectionLocked}
            {drafts}
            onsubmit={properties}
          />
        {/if}
        {#if selected.shape.type === "symbol"}
          <SymbolColorMode
            mode={selected.shape.colorMode}
            objectId={selected.id}
            targetKey={`${generation}:${screen.id}:${activeDefinition}`}
            locked={selectionLocked}
            {drafts}
            onsubmit={properties}
          />
        {/if}
        <form
          use:drafts.track={objectFormValues(selected, activeDefinition)}
          data-editor-form="object"
          onreset={() => (numericErrors = {})}
          onsubmit={(event) => {
            if (composing.size) event.preventDefault();
            else properties(event);
          }}
        >
          <fieldset disabled={selectionLocked}>
            <label class="placement-name"
              >配置名<input
                name="name"
                aria-label="配置名"
                oncompositionstart={compositionStart}
                oncompositionend={compositionEnd}
                onkeydown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.isComposing || composing.has(event.currentTarget))
                  )
                    event.preventDefault();
                }}
                maxlength="200"
                placeholder="未設定なら種類・表示順で表示"
              /></label
            >
            <p class="numeric-hint">
              配置名は「変更を適用」で確定します。
              {#if activeDefinition}共有定義内の名前は同じ定義を使う全配置で共用します。{/if}
            </p>
            <p class="numeric-hint">
              数値はEnter・フォーカス移動で確定 ·
              Escで取消。不透明度は0〜100%、0%でもレイヤーから選択できます。
            </p>
            {#if selected.shape.type === "image"}
              {@const assetId = selected.shape.assetId}
              {@const asset = project.assets.find((a) => a.id === assetId)!}
              <p class="numeric-hint">
                原本：{asset.name} · {asset.width} × {asset.height} px<br
                />画像は枠内で元比率を保ちます。余白も選択範囲に含みます。
              </p>
              <button
                type="button"
                onclick={() =>
                  edit({
                    type: "reset-image-ratio",
                    screenId: screen.id,
                    objectId: selected!.id,
                  })}>元比率へ戻す</button
              >
            {/if}
            <div class="fields">
              {#each "width" in selected ? ["x", "y", "width", "height", "rotation", "opacity"] : ["x", "y", "rotation", "opacity"] as field}
                <label
                  >{field === "rotation"
                    ? "回転（°）"
                    : field === "opacity"
                      ? "不透明度（%）"
                      : selected.shape.type === "image" && field === "width"
                        ? "画像枠の幅"
                        : selected.shape.type === "image" && field === "height"
                          ? "画像枠の高さ"
                          : field}<input
                    name={field}
                    aria-label={field === "rotation"
                      ? "回転角度"
                      : field === "opacity"
                        ? "不透明度（%）"
                        : field}
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
              {#if selected.shape.type !== "image"}
                <label
                  >{selected.shape.type === "symbol" &&
                  selected.shape.colorMode === "definition"
                    ? "単色の保存値"
                    : (selected.shape.type === "rectangle" ||
                          selected.shape.type === "ellipse") &&
                        !selected.shape.paint.fillEnabled
                      ? "塗りの保存値"
                      : "色"}<input
                    name="fill"
                    aria-label="色"
                    type="color"
                    disabled={(selected.shape.type === "symbol" &&
                      selected.shape.colorMode === "definition") ||
                      ((selected.shape.type === "rectangle" ||
                        selected.shape.type === "ellipse") &&
                        !selected.shape.paint.fillEnabled)}
                  /></label
                >
                <label>
                  {selected.shape.type === "symbol"
                    ? "単色"
                    : selected.shape.type === "text"
                      ? "文字"
                      : selected.shape.type === "polyline"
                        ? "線"
                        : "塗り"}の不透明度（%）
                  <input
                    name="colorAlpha"
                    aria-label="色の不透明度（%）"
                    type="text"
                    inputmode="decimal"
                    required
                    disabled={(selected.shape.type === "symbol" &&
                      selected.shape.colorMode === "definition") ||
                      ((selected.shape.type === "rectangle" ||
                        selected.shape.type === "ellipse") &&
                        !selected.shape.paint.fillEnabled)}
                    aria-invalid={numericErrors.colorAlpha ? "true" : undefined}
                    onfocus={focusNumber}
                    oninput={clearNumber}
                    onkeydown={numberKey}
                    onblur={blurNumber}
                    oncompositionstart={compositionStart}
                    oncompositionend={compositionEnd}
                  />
                  {#if numericErrors.colorAlpha}<span
                      class="field-error"
                      role="alert">{numericErrors.colorAlpha}</span
                    >{/if}
                </label>
              {/if}
              {#if selected.shape.type === "symbol" && selected.shape.colorMode === "definition"}<p
                  class="numeric-hint"
                >
                  現在の描画にはこの単色を使用していません。各図形の色は共有定義で編集します。色と不透明度の保存値は保持し、色の使い方を「配置の単色」に適用した後に編集できます。
                </p>{/if}
              {#if (selected.shape.type === "rectangle" || selected.shape.type === "ellipse") && !selected.shape.paint.fillEnabled}<p
                  class="numeric-hint"
                >
                  塗りは無効です。色と不透明度の保存値は保持し、塗りを「あり」に適用した後に編集できます。
                </p>{/if}
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
                    aria-invalid={numericErrors.strokeWidth
                      ? "true"
                      : undefined}
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
                  >線種<select name="lineStyle" aria-label="線種"
                    ><option value="solid">実線</option><option value="dashed"
                      >破線</option
                    ><option value="dotted">点線</option></select
                  ></label
                >
                <label
                  >矢印<select name="arrow" aria-label="矢印"
                    ><option value="none">なし</option><option value="end"
                      >終点</option
                    ></select
                  ></label
                >
              {/if}
              {#if selected.shape.type === "text"}
                <label
                  >文字サイズ<input
                    name="fontSize"
                    aria-label="文字サイズ"
                    type="text"
                    inputmode="decimal"
                    required
                    aria-invalid={numericErrors.fontSize ? "true" : undefined}
                    aria-describedby={numericErrors.fontSize
                      ? "numeric-fontSize-error"
                      : undefined}
                    onfocus={focusNumber}
                    oninput={clearNumber}
                    onkeydown={numberKey}
                    onblur={blurNumber}
                    oncompositionstart={compositionStart}
                    oncompositionend={compositionEnd}
                  />{#if numericErrors.fontSize}<span
                      class="field-error"
                      id="numeric-fontSize-error"
                      role="alert">{numericErrors.fontSize}</span
                    >{/if}</label
                >
                <label
                  >文字の太さ<select name="fontWeight" aria-label="文字の太さ"
                    ><option value="normal">標準</option><option value="bold"
                      >太字</option
                    ></select
                  ></label
                >
                <label
                  >文字揃え<select name="textAlign" aria-label="文字揃え"
                    ><option value="left">左</option><option value="center"
                      >中央</option
                    ><option value="right">右</option></select
                  ></label
                >
                <p class="full-width numeric-hint">
                  1行・上下中央。文字サイズは枠のサイズ変更に追従しません。太さ・揃え・テキストは「変更を適用」で確定します。
                </p>
                <label class="full-width"
                  >テキスト<input
                    name="text"
                    aria-label="テキスト"
                    onpaste={pasteText}
                    oninput={() => (textError = "")}
                    maxlength="1000"
                  />{#if textError}<span class="field-error" role="alert"
                      >{textError}</span
                    >{/if}</label
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
                        >{definition.name} · {symbolUsage(
                          project,
                          definition.id,
                        )} 配置</option
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
          </fieldset>
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
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  fieldset:disabled {
    opacity: 0.65;
  }
  .lock-status {
    font-size: 12px;
  }

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
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--banto-surface);
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
  .placement-name,
  .fields label {
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  .placement-name input,
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
    display: grid;
    align-items: baseline;
    gap: 8px;
    padding: 4px 14px 0;
    overflow-wrap: anywhere;
    font-size: 13px;
  }
  .inspector-subject strong {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .inspector-subject small {
    color: var(--banto-text-muted);
    font-size: 10px;
  }
  .fields > .numeric-hint {
    grid-column: 1 / -1;
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
