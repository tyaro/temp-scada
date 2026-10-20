<script lang="ts">
  import FloatingPanelHeader from "./FloatingPanelHeader.svelte";
  import SelectionTextStyle from "./SelectionTextStyle.svelte";
  import SelectionSize from "./SelectionSize.svelte";
  import SelectionOpacity from "./SelectionOpacity.svelte";
  import type { FloatingInspector } from "./controllers/floating-inspector.svelte";
  import SymbolEquipmentCheck from "./SymbolEquipmentCheck.svelte";
  import StateColor from "./StateColor.svelte";
  import { stateColorUsages } from "../state-color";
  import GroupInspector from "./GroupInspector.svelte";
  import { selectedGroup, groupFor } from "../geometric-groups";
  import { screenViewOptions } from "../screen-references";
  import { placementLabel } from "../placement-label";
  import ImageFitSettings from "./ImageFitSettings.svelte";
  import ImageCrop from "./ImageCrop.svelte";
  import ShapePaint from "./ShapePaint.svelte";
  import SelectionColor from "./SelectionColor.svelte";
  import SelectionOutline from "./SelectionOutline.svelte";
  import SelectionLine from "./SelectionLine.svelte";
  import BoolColors from "./BoolColors.svelte";
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
  import type {
    Project,
    Screen,
    SymbolDefinition,
    ScreenObject,
  } from "../project";
  import type { EditCommand } from "../editor";
  import { symbolUsage } from "../editor";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    element = $bindable<HTMLElement>(),
    visible,
    layout,
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
    onselectsource,
    onopenequipment,
    onopenequipmentsettings,
    openScreen,
    onreplaceimage,
    imageBusy,
    images,
  }: {
    element?: HTMLElement;
    visible: boolean;
    layout?: FloatingInspector;
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
    screen: Screen | SymbolDefinition;
    drafts: ReturnType<typeof createDraftGuard>;
    properties: (event: SubmitEvent) => void;
    moveSelection: (event: SubmitEvent) => void;
    edit: (command: EditCommand) => boolean;
    openDefinition: (id: string) => void;
    onselectsource: (id: string) => void;
    onopenequipment: (objectId: string) => void;
    onopenequipmentsettings: (objectId: string) => void;
    openScreen: (id: string) => void;
    onreplaceimage: (id: string) => void;
    imageBusy: boolean;
    images: ReadonlyMap<string, { url: string; width: number; height: number }>;
  } = $props();
  const group = $derived(selectedGroup(screen, selectedIds));
  const containsGroups = $derived(
    selectedIds.some((id) => groupFor(screen, id)),
  );
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
              ...(object.shape.paint.fill.enabled
                ? object.shape.paint.fill.paint.type === "solid"
                  ? [object.shape.paint.fill.paint.color.toLowerCase()]
                  : object.shape.paint.fill.paint.type === "pattern"
                    ? [
                        object.shape.paint.fill.paint.foreground.color.toLowerCase(),
                        ...(object.shape.paint.fill.paint.background
                          ? [
                              object.shape.paint.fill.paint.background.color.toLowerCase(),
                            ]
                          : []),
                      ]
                    : [
                        object.shape.paint.fill.paint.start.color.toLowerCase(),
                        object.shape.paint.fill.paint.end.color.toLowerCase(),
                      ]
                : []),
              ...(object.shape.paint.stroke
                ? [object.shape.paint.stroke.color.toLowerCase()]
                : []),
            ];
          return object.shape.type === "image" ||
            object.shape.type === "screenView"
            ? []
            : [object.fill!.toLowerCase()];
        }),
    ),
  );
  const paintDisabledCount = $derived(
    screen.objects.filter(
      (object) =>
        selectedIds.includes(object.id) &&
        (object.shape.type === "rectangle" ||
          object.shape.type === "ellipse") &&
        !object.shape.paint.fill.enabled &&
        !object.shape.paint.stroke,
    ).length,
  );
  const gradientCount = $derived(
    screen.objects.filter(
      (object) =>
        selectedIds.includes(object.id) &&
        (object.shape.type === "rectangle" ||
          object.shape.type === "ellipse") &&
        object.shape.paint.fill.enabled &&
        object.shape.paint.fill.paint.type !== "solid",
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
  let tagInput = $state<HTMLInputElement>();
  let pickerOpen = $state(false);
  export function isTagPickerOpen() {
    return pickerOpen;
  }
  export function focusName() {
    const input = element?.querySelector<HTMLInputElement>(
      'form[data-editor-form="group-name"] input[name="name"], form[data-editor-form="object"] input[name="name"]',
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
  const composing = new Set<HTMLInputElement | HTMLTextAreaElement>();
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
  function textAreaKey(event: KeyboardEvent) {
    if (
      event.key !== "Enter" ||
      !(event.ctrlKey || event.metaKey) ||
      event.altKey
    )
      return;
    event.preventDefault();
    const textarea = event.currentTarget as HTMLTextAreaElement;
    if (event.isComposing || event.keyCode === 229 || composing.has(textarea))
      return;
    textarea.form?.requestSubmit();
  }
  function compositionStart(event: CompositionEvent) {
    composing.add(
      event.currentTarget as HTMLInputElement | HTMLTextAreaElement,
    );
  }
  function compositionEnd(event: CompositionEvent) {
    const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
    composing.delete(input);
    if (input instanceof HTMLInputElement && blurred.has(input)) {
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
  onpointerdown={() => layout?.raise()}
  onfocusin={() => layout?.raise()}
  class:floating={layout?.floating}
  data-panel-placement={layout?.floating ? "floating" : "docked"}
  style={layout?.style}
  id="designer-inspector-panel"
  aria-label="プロパティパネル"
  bind:this={element}
  hidden={!visible}
  tabindex="-1"
>
  <FloatingPanelHeader {layout} {onclose} />
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
    {#if selectedIds.length === 1 && selected?.shape.type === "symbol" && !activeDefinition}
      <button
        type="button"
        disabled={!selected.shape.equipmentId}
        title={selected.shape.equipmentId
          ? "全画面で共有する機器台帳の設定を開く。配置のロックとは別に編集します。"
          : "先に機器を関連付けてください"}
        onclick={() => selected && onopenequipmentsettings(selected.id)}
        >関連機器の台帳設定を開く</button
      >
      <button
        type="button"
        disabled={!selected.shape.equipmentId}
        title={selected.shape.equipmentId
          ? "表示プレビューへ切り替えて関連機器の読取詳細を開く"
          : "先に機器を関連付けてください"}
        onclick={() => selected && onopenequipment(selected.id)}
        >関連機器の読取詳細を開く</button
      >
      {#if !selected.shape.equipmentId}<p>
          機器を関連付けると読取詳細を開けます。
        </p>{/if}
    {/if}
    {#if selectedIds.length > 1}
      {#if group}
        {#key `${generation}:${screen.id}:${group.id}`}
          <GroupInspector
            {group}
            objects={screen.objects.filter((object) =>
              group.memberIds.includes(object.id),
            )}
            {generation}
            screenId={screen.id}
            locked={selectionLocked}
            {drafts}
            {properties}
          />
        {/key}
      {/if}
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
      {#if !containsGroups}
        {#key `${generation}:${screen.id}:${activeDefinition}:${[...selectedIds].sort().join(",")}`}
          <SelectionSize
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
          <SelectionOpacity
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
          <SelectionColor
            current={commonColor}
            {definitionColorCount}
            {gradientCount}
            imageCount={screen.objects.filter(
              (o) =>
                selectedIds.includes(o.id) &&
                (o.shape.type === "image" || o.shape.type === "screenView"),
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
          <SelectionTextStyle
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
      {:else}<p>グループを含むため、内部の書式は解除後に編集できます。</p>{/if}
    {:else if selected}
      {#key `${generation}:${screen.id}:${selected.id}`}
        {#if activeDefinition && (selected.shape.type === "rectangle" || selected.shape.type === "ellipse" || selected.shape.type === "polyline")}
          <StateColor
            definition={screen as SymbolDefinition}
            object={selected}
            targetKey={`${generation}:${screen.id}:${activeDefinition}`}
            locked={selectionLocked}
            {drafts}
            onsubmit={properties}
            onsource={(id) => onselectsource(id)}
          />
        {/if}
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
        {#if selected.shape.type === "image"}
          {@const assetId = selected.shape.assetId}
          {@const asset = project.assets.find((a) => a.id === assetId)!}
          {#key assetId}
            <ImageFitSettings
              image={images.get(assetId)}
              fit={selected.shape.fit}
              crop={selected.shape.crop}
              width={"width" in selected ? selected.width : 1}
              height={"height" in selected ? selected.height : 1}
              objectId={selected.id}
              targetKey={`${generation}:${screen.id}:${activeDefinition}`}
              locked={selectionLocked}
              {drafts}
              onsubmit={properties}
            />
            <ImageCrop
              {asset}
              url={images.get(assetId)?.url}
              crop={selected.shape.crop}
              objectId={selected.id}
              targetKey={`${generation}:${screen.id}:${activeDefinition}`}
              locked={selectionLocked}
              {drafts}
              onsubmit={properties}
            />
          {/key}
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
        {#if activeDefinition && selected.shape.type === "text" && ("readSlots" in screen ? screen.readSlots : [])?.some((slot) => slot.name === (selected.shape.type === "text" ? selected.shape.slotBinding?.slotName : undefined) && slot.type === "bool")}
          {@const followers = stateColorUsages(
            screen as SymbolDefinition,
            selected.id,
          )}
          {#if followers.length}<p class="numeric-hint">
              状態色の追従先 {followers.length}件。配色とbool
              slotの変更はすべてに反映します。配色元の削除・配色解除・number化は先に追従を解除してください。
            </p>{/if}
          <BoolColors
            colors={selected.shape.boolColors}
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
                />選択した表示方式で枠内に描画します。余白を含む枠全体が選択範囲です。
              </p>
              <button
                type="button"
                disabled={imageBusy}
                onclick={() => selected && onreplaceimage(selected.id)}
                title="別の原本への差し替えでは切出しを解除し、表示方式と配置枠は維持します。"
                >画像を差し替え…</button
              >
              <button
                type="button"
                onclick={() =>
                  edit({
                    type: "reset-image-ratio",
                    screenId: screen.id,
                    objectId: selected!.id,
                  })}
                >{selected.shape.crop
                  ? "切出し範囲の比率に合わせる"
                  : "元比率へ戻す"}</button
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
              {#if selected.shape.type !== "image" && selected.shape.type !== "screenView" && selected.shape.type !== "rectangle" && selected.shape.type !== "ellipse"}
                <label
                  >{selected.shape.type === "symbol" &&
                  selected.shape.colorMode === "definition"
                    ? "単色の保存値"
                    : "色"}<input
                    name="fill"
                    aria-label="色"
                    type="color"
                    disabled={selected.shape.type === "symbol" &&
                      selected.shape.colorMode === "definition"}
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
                    disabled={selected.shape.type === "symbol" &&
                      selected.shape.colorMode === "definition"}
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
              {#if (selected.shape.type === "rectangle" || selected.shape.type === "ellipse") && !selected.shape.paint.fill.enabled}<p
                  class="numeric-hint"
                >
                  塗りは無効です。色と不透明度の設定は保持され、現在の描画には使われません。
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
                  静的テキストは改行できます。自動折返しはしません。Enterで改行、Ctrl／⌘＋Enterまたは「変更を適用」で確定します。文字サイズは枠変更で変わりません。タグ・機器情報の表示は1行です。
                </p>
                <label class="full-width"
                  >テキスト<textarea
                    name="text"
                    aria-label="テキスト"
                    rows="4"
                    wrap="off"
                    maxlength="1000"
                    oncompositionstart={compositionStart}
                    oncompositionend={compositionEnd}
                    onkeydown={textAreaKey}></textarea></label
                >
                {#if activeDefinition}
                  <label class="full-width"
                    >表示元<select name="slotName" aria-label="表示元"
                      ><option value="">静的テキスト</option>
                      <optgroup label="機器情報">
                        <option value="@code">機器コード</option>
                        <option value="@name">機器名</option>
                        <option value="@typeName">機器種別名</option>
                      </optgroup><optgroup label="読取slot"
                        >{#each ("readSlots" in screen ? screen.readSlots : []) ?? [] as slot}<option
                            value={slot.name}>{slot.name} · {slot.type}</option
                          >{/each}</optgroup
                      ></select
                    ></label
                  >
                  <p class="full-width tag-note">
                    配置に関連付けた機器から解決します。機器情報は保存した台帳を表示し、定義編集中だけ例示します。読取slotは定義編集中も機器未関連付けです。機器情報・静的テキスト・number
                    slotへ変更すると状態別の文字色も解除します。
                  </p>
                {:else}
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
              {#if selected.shape.type === "screenView"}
                <label class="full-width"
                  >参照する画面<select
                    name="sourceScreenId"
                    aria-label="参照する画面"
                  >
                    {#each screenViewOptions(project, screen.id, selected.id) as source (source.id)}
                      <option value={source.id} disabled={!!source.reason}
                        >{source.name}{source.reason
                          ? `（${source.reason}）`
                          : ""}</option
                      >
                    {/each}
                  </select></label
                >
              {/if}
              {#if selected.shape.type === "symbol"}
                {#if !activeDefinition}
                  <label class="full-width"
                    >関連付ける機器<select
                      name="equipmentId"
                      aria-label="関連付ける機器"
                    >
                      <option value="">関連付けなし</option>
                      {#each project.equipment ?? [] as equipment (equipment.id)}<option
                          value={equipment.id}
                          >{equipment.code} · {equipment.name}</option
                        >{/each}
                    </select></label
                  >
                  <p class="full-width">
                    機器の割付状態と状態色を表示します。通常Designerの実Hub接続は後続です。同じ機器の表示を複製しても割付は共有します。
                  </p>
                {/if}
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
            {#if selected.shape.type === "screenView"}
              <p>
                参照先の背景と配置を読み取り表示します。元画面の変更はすべての使用先へ反映されます。
              </p>
              <button
                type="button"
                onclick={() => {
                  if (selected?.shape.type === "screenView")
                    openScreen(selected.shape.screenId);
                }}>参照する画面を開く</button
              >
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
          {#if selected.shape.type === "symbol" && !activeDefinition}
            <SymbolEquipmentCheck
              {project}
              targetKey={`${generation}:${screen.id}:${selected.id}`}
              symbolId={selected.shape.symbolId}
              equipmentId={selected.shape.equipmentId ?? ""}
            />
          {/if}
        </form>
      {/key}
    {:else}<p>
        図形をクリック、または一覧から選んでください。図形はドラッグして移動できます。
      </p>{/if}
  </div>
  {#if layout?.floating && layout.rect}
    <button
      type="button"
      class="floating-size"
      aria-label="プロパティパネルのサイズを変更"
      aria-describedby="inspector-placement-help"
      title="ドラッグでサイズ変更。Enterでキーボード操作"
      style:left={`${layout.rect.x + layout.rect.width - 22}px`}
      style:top={`${layout.rect.y + layout.rect.height - 22}px`}
      onpointerdown={(event) => layout?.pointerStart("resize", event)}
      onkeydown={(event) => layout?.keyboardStart("resize", event)}>↘</button
    >
  {/if}
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
  .inspector.floating {
    z-index: calc(var(--banto-z-header, 100) + 1);
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    box-shadow: 0 10px 32px #0003;
  }
  .floating-size {
    position: fixed;
    width: 22px;
    height: 22px;
    margin: 0;
    padding: 0;
    z-index: 2;
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    touch-action: none;
    cursor: nwse-resize;
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
  .fields label:has(textarea) {
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
