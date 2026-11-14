<script lang="ts">
  import type { Snippet } from "svelte";
  import FloatingPanelHeader from "./FloatingPanelHeader.svelte";
  import { lineArrowLabels, lineArrows } from "../line-arrow";
  import SelectionTextStyle from "./SelectionTextStyle.svelte";
  import SelectionSize from "./SelectionSize.svelte";
  import SelectionOpacity from "./SelectionOpacity.svelte";
  import SelectionPaintAlpha from "./SelectionPaintAlpha.svelte";
  import type { FloatingInspector } from "./controllers/floating-inspector.svelte";
  import SymbolEquipmentCheck from "./SymbolEquipmentCheck.svelte";
  import StateColor from "./StateColor.svelte";
  import { frameScreenIds } from "../operator-frame";
  import { stateColorSources, stateColorUsages } from "../state-color";
  import GroupInspector from "./GroupInspector.svelte";
  import { selectedGroup, groupFor } from "../geometric-groups";
  import { screenViewOptions } from "../screen-references";
  import { placementLabel } from "../placement-label";
  import ImageFitSettings from "./ImageFitSettings.svelte";
  import ConnectionSettings from "./ConnectionSettings.svelte";
  import { connectionUsages } from "../connections";
  import ImageCrop from "./ImageCrop.svelte";
  import ShapePaint from "./ShapePaint.svelte";
  import SelectionColor from "./SelectionColor.svelte";
  import SelectionOutline from "./SelectionOutline.svelte";
  import SelectionLine from "./SelectionLine.svelte";
  import { isStateSlotType } from "../equipment";
  import StateTextColor from "./StateTextColor.svelte";
  import BoolDisplay from "./BoolDisplay.svelte";
  import NumericFormat from "./NumericFormat.svelte";
  import SymbolColorMode from "./SymbolColorMode.svelte";
  import TagPicker from "./TagPicker.svelte";
  import { sampleSelection, type CatalogSelection } from "../catalog-session";
  import { numericTag, type CatalogTag, type TagCatalog } from "./tag-catalog";
  import {
    geometryLabel,
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
  import { canFlip } from "../flip";
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
    onmanagetrend,
    onopentrend,
    openScreen,
    onreplaceimage,
    imageBusy,
    images,
    catalogSelection = sampleSelection,
    screenSettings,
    showScreenSettings = false,
  }: {
    element?: HTMLElement;
    catalogSelection?: CatalogSelection;
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
    onmanagetrend?: (id: string) => void;
    onopentrend?: (objectId: string) => void;
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
    /** Settings of the open screen or Symbol definition, shown while nothing is selected. */
    screenSettings?: Snippet;
    /** Show the settings even with a selection (revealing an unapplied or invalid field). */
    showScreenSettings?: boolean;
  } = $props();
  /** 画面切替ボタンの行き先にできない、運転表示のヘッダー・フッターの画面。 */
  const frameScreens = $derived(frameScreenIds(project.operatorFrame));
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
            object.shape.type === "screenView" ||
            object.shape.type === "navButton" ||
            object.shape.type === "trend"
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
    if (
      pickerOpen &&
      (pickerRequest?.key !== pickerKey ||
        pickerRequest.catalog !== catalogSelection.catalog ||
        !catalogSelection.isCurrent())
    )
      pickerOpen = false;
  });
  function openTagPicker() {
    if (
      !catalogSelection.available ||
      !catalogSelection.isCurrent() ||
      !tagInput ||
      !selected ||
      selected.locked ||
      (selected.shape.type !== "text" && selected.shape.type !== "level") ||
      activeDefinition ||
      !visible ||
      drafts.pending
    )
      return;
    const kindLabel = selected.shape.type === "level" ? "液位" : "Text";
    pickerRequest = {
      key: pickerKey,
      input: tagInput,
      catalog: catalogSelection.catalog,
      revision: catalogSelection.catalog.revision,
      label: `${screen.name} ／ ${selected.name ? `${selected.name}（${kindLabel} · ${selected.order}）` : `${kindLabel} · ${selected.order}`} ／ 表示タグ`,
    };
    pickerOpen = true;
  }
  function chooseTag(tag: CatalogTag, revision: string) {
    const request = pickerRequest;
    if (
      (selected?.shape.type !== "text" && selected?.shape.type !== "level") ||
      selected.locked ||
      activeDefinition ||
      !visible ||
      drafts.pending ||
      !pickerOpen ||
      !request ||
      request.key !== pickerKey ||
      request.input !== tagInput ||
      !request.input.isConnected ||
      !catalogSelection.isCurrent() ||
      request.catalog !== catalogSelection.catalog ||
      request.revision !== revision ||
      catalogSelection.catalog.revision !== revision ||
      !numericTag(tag) ||
      !catalogSelection.catalog.tags.some(
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
  let objectForm = $state<HTMLFormElement>();
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
  /** 表の入力欄: Tab はタブを入れる（Shift＋Tab は前の欄へ）。Ctrl／⌘＋Enter で確定。 */
  function tableAreaKey(event: KeyboardEvent) {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.isComposing &&
      !composing.has(textarea)
    ) {
      event.preventDefault();
      textarea.setRangeText(
        "\t",
        textarea.selectionStart,
        textarea.selectionEnd,
        "end",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    textAreaKey(event);
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
            <label class="banto-field banto-field--stacked"
              ><span class="banto-field-label">移動量 X</span><input
                class="banto-field-control"
                name="dx"
                aria-label="移動量 X"
                type="number"
                step="any"
                required
                value="0"
              /></label
            ><label class="banto-field banto-field--stacked"
              ><span class="banto-field-label">移動量 Y</span><input
                class="banto-field-control"
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
          <SelectionPaintAlpha
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
                (o.shape.type === "image" ||
                  o.shape.type === "screenView" ||
                  o.shape.type === "navButton" ||
                  o.shape.type === "trend"),
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
        {#if (selected.shape.type === "rectangle" || selected.shape.type === "ellipse" || selected.shape.type === "polyline") && (activeDefinition || selected.shape.stateColor || stateColorSources(screen).length > 0)}
          <StateColor
            owner={screen}
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
        {#if selected.shape.type === "polyline" && !activeDefinition}
          <ConnectionSettings
            objectId={selected.id}
            connections={selected.shape.connections}
            objects={screen.objects}
            {project}
            targetKey={`${generation}:${screen.id}:${activeDefinition}`}
            locked={selectionLocked}
            disabledReason={groupFor(screen, selected.id)
              ? "グループ内の線は接続できません。先にグループを解除してください。"
              : undefined}
            {drafts}
            onsubmit={properties}
          />
        {/if}
        {#if selected.shape.type === "symbol" && !activeDefinition}
          {@const usages = connectionUsages(screen, selected.id)}
          {#if usages.length}
            <section
              class="connection-usages"
              aria-label="このSymbolに接続中の配管"
            >
              <h3>接続中の配管 · {usages.length}端点</h3>
              <ul>
                {#each usages as usage (`${usage.objectId}:${usage.end}`)}
                  <li>
                    {usage.name ??
                      placementLabel(
                        screen.objects.find((o) => o.id === usage.objectId)!,
                        project.symbols,
                      )} · {usage.end === "start" ? "始点" : "終点"}（{{
                      top: "上",
                      right: "右",
                      bottom: "下",
                      left: "左",
                      center: "中心",
                    }[usage.anchor]}）
                  </li>
                {/each}
              </ul>
              <p class="numeric-hint">
                接続を解除するか配管も選択してから、このSymbolを削除してください。
              </p>
            </section>
          {/if}
        {/if}
        {#if selected.shape.type === "image"}
          {@const assetId = selected.shape.assetId}
          {@const asset = project.assets.find((a) => a.id === assetId)!}
          {#if activeDefinition}<p class="numeric-hint">
              共有定義内の画像変更は、このSymbolを使うすべての配置に反映されます。
            </p>{/if}
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
        {#if activeDefinition && selected.shape.type === "text" && ("readSlots" in screen ? screen.readSlots : [])?.some((slot) => slot.name === (selected.shape.type === "text" ? selected.shape.slotBinding?.slotName : undefined) && isStateSlotType(slot.type))}
          {@const followers = stateColorUsages(
            screen as SymbolDefinition,
            selected.id,
          )}
          {#if followers.length}<p class="numeric-hint">
              状態色の追従先 {followers.length}件。取得不能の色とslotの変更はすべてに反映します。配色元の削除・指定の解除・number化は先に追従を解除してください。
            </p>{/if}
          <StateTextColor
            colors={selected.shape.stateColors}
            objectId={selected.id}
            targetKey={`${generation}:${screen.id}:${activeDefinition}`}
            locked={selectionLocked}
            {drafts}
            onsubmit={properties}
          />
        {/if}
        {#if selected.shape.type === "text" && selected.shape.binding && !activeDefinition}
          {@const screenFollowers = selected.shape.boolDisplay
            ? stateColorUsages(screen, selected.id)
            : []}
          {#if screenFollowers.length}<p class="numeric-hint">
              状態色の追従先 {screenFollowers.length}件。bool表示の削除・タグの解除・Textの削除は先に追従を解除してください。
            </p>{/if}
          <BoolDisplay
            display={selected.shape.boolDisplay}
            hasFormat={!!selected.shape.format}
            objectId={selected.id}
            targetKey={`${generation}:${screen.id}:${activeDefinition}`}
            locked={selectionLocked}
            {drafts}
            onsubmit={properties}
          />
        {/if}
        {#if selected.shape.type === "text" && !selected.shape.boolDisplay && (selected.shape.binding || (selected.shape.slotBinding && (selected.shape.format || ("readSlots" in screen ? screen.readSlots : [])?.some((slot) => slot.name === (selected.shape.type === "text" ? selected.shape.slotBinding?.slotName : undefined) && slot.type === "number"))))}
          {@const externalName = selected.shape.binding?.externalName}
          <NumericFormat
            format={selected.shape.format}
            catalogUnit={externalName === undefined
              ? undefined
              : catalogSelection.catalog.tags.find(
                  (tag) => tag.externalName === externalName,
                )?.unit}
            objectId={selected.id}
            targetKey={`${generation}:${screen.id}:${activeDefinition}`}
            locked={selectionLocked}
            {drafts}
            onsubmit={properties}
          />
        {/if}
        <form
          bind:this={objectForm}
          use:drafts.track={objectFormValues(selected, activeDefinition)}
          data-editor-form="object"
          onreset={() => (numericErrors = {})}
          onsubmit={(event) => {
            if (composing.size) event.preventDefault();
            else properties(event);
          }}
        >
          <fieldset disabled={selectionLocked}>
            <label class="placement-name banto-field banto-field--stacked"
              ><span class="banto-field-label">配置名</span><input
                class="banto-field-control"
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
            <!-- UX精査 P1-2: 規則の説明は1行に絞り、詳細は折りたたみへ移す（キーボード・タッチでも開ける。入力欄は aria-describedby で結ぶ）。 -->
            <details class="numeric-hint hint-details">
              <summary
                >数値は Enter、ほかは「変更を適用」で確定 · Esc で取消</summary
              >
              <p id="inspector-commit-help">
                数値の欄は Enter またはフォーカス移動で確定し、Esc
                で取り消します。配置名・テキスト・タグなどは「変更を適用」で確定します。適用前にほかの図形や画面へ移ると、そのまま適用します。不透明度は0〜100%で、0%でもレイヤーから選択できます。
              </p>
            </details>
            {#if activeDefinition}<p class="numeric-hint">
                共有定義内の名前は同じ定義を使う全配置で共用します。
              </p>{/if}
            {#if selected.shape.type === "image"}
              {@const assetId = selected.shape.assetId}
              {@const asset = project.assets.find((a) => a.id === assetId)!}
              <details class="numeric-hint hint-details">
                <summary
                  >原本：{asset.name} · {asset.width} × {asset.height} px</summary
                >
                <p id="inspector-image-frame-help">
                  選択した表示方式で枠内に描画します。余白を含む枠全体が選択範囲です。
                </p>
              </details>
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
                {@const label = geometryLabel(field, selected.shape.type)}
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">{label.visible}</span><input
                    class="banto-field-control"
                    name={field}
                    aria-label={label.accessible}
                    type="text"
                    inputmode="decimal"
                    required
                    aria-invalid={numericErrors[field] ? "true" : undefined}
                    aria-describedby={[
                      numericErrors[field] ? `numeric-${field}-error` : "",
                      "inspector-commit-help",
                      selected.shape.type === "image" &&
                      (field === "width" || field === "height")
                        ? "inspector-image-frame-help"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
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
              {#if canFlip(selected)}
                <div
                  class="flip-toggles"
                  role="group"
                  aria-label="保存する反転（配置の軸・角度は変えない）"
                >
                  {#each [["flipX", "左右反転"], ["flipY", "上下反転"]] as const as [key, label]}
                    <!-- A button stays outside the draft form state; pending drafts block it. -->
                    <button
                      type="button"
                      class="flip-toggle"
                      data-flip-toggle={key}
                      aria-label={`${label}（配置の軸）`}
                      aria-pressed={selected[key] === true}
                      disabled={selected.locked}
                      title="保存する配置の軸の反転を切り替えます。角度は変えません。"
                      onclick={() => {
                        if (!selected || selected.locked || drafts.pending)
                          return;
                        edit({
                          type: "update",
                          screenId: screen.id,
                          objectId: selected.id,
                          patch: { [key]: selected[key] !== true },
                        });
                      }}>{label}</button
                    >
                  {/each}
                </div>
              {/if}
              {#if selected.shape.type !== "image" && selected.shape.type !== "screenView" && selected.shape.type !== "navButton" && selected.shape.type !== "trend" && selected.shape.type !== "rectangle" && selected.shape.type !== "ellipse"}
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
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">
                    {selected.shape.type === "symbol"
                      ? "単色"
                      : selected.shape.type === "text" ||
                          selected.shape.type === "table" ||
                          selected.shape.type === "clock"
                        ? "文字"
                        : selected.shape.type === "polyline"
                          ? "線"
                          : "塗り"}の不透明度（%）
                  </span><input
                    class="banto-field-control"
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
              {#if selected.shape.type === "symbol"}<p class="numeric-hint">
                  画像のRGBは原色を保持します。配置の単色モードでは、色の不透明度が画像を含むSymbol全体に作用します。
                </p>{/if}
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
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">頂点（x,y を1行ずつ）</span
                  ><textarea
                    class="banto-field-control"
                    name="points"
                    aria-label="頂点"
                    rows="5"
                    required></textarea></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">線幅</span><input
                    class="banto-field-control"
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
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">線種</span><select
                    class="banto-field-control"
                    name="lineStyle"
                    aria-label="線種"
                    ><option value="solid">実線</option><option value="dashed"
                      >破線</option
                    ><option value="dotted">点線</option></select
                  ></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">矢印</span><select
                    class="banto-field-control"
                    name="arrow"
                    aria-label="矢印"
                    >{#each lineArrows as value (value)}<option {value}
                        >{lineArrowLabels[value]}</option
                      >{/each}</select
                  ></label
                >
              {/if}
              {#if selected.shape.type === "text"}
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">文字サイズ</span><input
                    class="banto-field-control"
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
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">文字の太さ</span><select
                    class="banto-field-control"
                    name="fontWeight"
                    aria-label="文字の太さ"
                    ><option value="normal">標準</option><option value="bold"
                      >太字</option
                    ></select
                  ></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">文字揃え</span><select
                    class="banto-field-control"
                    name="textAlign"
                    aria-label="文字揃え"
                    ><option value="left">左</option><option value="center"
                      >中央</option
                    ><option value="right">右</option></select
                  ></label
                >
                <details class="full-width numeric-hint hint-details">
                  <summary>Enter で改行、Ctrl／⌘＋Enter で確定</summary>
                  <p id="inspector-text-help">
                    静的テキストは改行・枠幅での折返しに対応します。文字サイズは枠の変更では変わりません。タグ・機器情報の表示は1行です。
                  </p>
                </details>
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">折返し</span><select
                    class="banto-field-control"
                    name="textWrap"
                    aria-label="文字の折返し"
                    ><option value="none">折返しなし</option><option
                      value="word">枠幅で折返し</option
                    ></select
                  ></label
                >
                <label class="full-width banto-field banto-field--stacked"
                  ><span class="banto-field-label">テキスト</span><textarea
                    class="banto-field-control"
                    name="text"
                    aria-label="テキスト"
                    aria-describedby="inspector-text-help"
                    rows="4"
                    wrap="off"
                    maxlength="1000"
                    oncompositionstart={compositionStart}
                    oncompositionend={compositionEnd}
                    onkeydown={textAreaKey}></textarea></label
                >
                {#if activeDefinition}
                  <label class="full-width banto-field banto-field--stacked"
                    ><span class="banto-field-label">表示元</span><select
                      class="banto-field-control"
                      name="slotName"
                      aria-label="表示元"
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
                    slotへ変更すると状態の色に従う指定も解除します。
                  </p>
                {:else}
                  <div class="full-width tag-binding">
                    <label class="banto-field banto-field--stacked"
                      ><span class="banto-field-label">表示タグ（外部名）</span
                      ><input
                        class="banto-field-control"
                        bind:this={tagInput}
                        name="externalName"
                        data-explicit-apply
                        aria-label="表示タグ（外部名）"
                        maxlength="1024"
                        placeholder="PLC01.Fast.Tank01.Level"
                      /></label
                    >
                    <button
                      type="button"
                      aria-label="タグを選択"
                      title="候補からタグを選択"
                      disabled={!catalogSelection.available}
                      onclick={openTagPicker}>…</button
                    >
                  </div>
                  <p class="full-width tag-note">
                    {catalogSelection.notice}
                  </p>
                {/if}
              {/if}
              {#if selected.shape.type === "level"}
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">向き</span><select
                    class="banto-field-control"
                    name="levelDirection"
                    aria-label="液位の向き"
                    ><option value="up">下から上</option><option value="right"
                      >左から右</option
                    ></select
                  ></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">下限</span><input
                    class="banto-field-control"
                    name="levelMin"
                    aria-label="液位の下限"
                    type="text"
                    inputmode="decimal"
                  /></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">上限</span><input
                    class="banto-field-control"
                    name="levelMax"
                    aria-label="液位の上限"
                    type="text"
                    inputmode="decimal"
                  /></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">地</span><select
                    class="banto-field-control"
                    name="levelBackgroundMode"
                    aria-label="液位の地"
                    ><option value="color">色で塗る</option><option value="none"
                      >透明</option
                    ></select
                  ></label
                >
                <label
                  >地の色<input
                    name="levelBackground"
                    aria-label="液位の地の色"
                    type="color"
                  /></label
                >
                {#if activeDefinition}
                  <label class="full-width banto-field banto-field--stacked"
                    ><span class="banto-field-label">表示元</span><select
                      class="banto-field-control"
                      name="slotName"
                      aria-label="表示元"
                      ><option value="">なし</option>
                      {#each (("readSlots" in screen ? screen.readSlots : []) ?? []).filter((slot) => slot.type === "number") as slot}<option
                          value={slot.name}>{slot.name} · {slot.type}</option
                        >{/each}</select
                    ></label
                  >
                  <p class="full-width tag-note">
                    number
                    の読取slotだけを選べます。配置に関連付けた機器から解決します。
                  </p>
                {:else}
                  <div class="full-width tag-binding">
                    <label class="banto-field banto-field--stacked"
                      ><span class="banto-field-label">表示タグ（外部名）</span
                      ><input
                        class="banto-field-control"
                        bind:this={tagInput}
                        name="externalName"
                        data-explicit-apply
                        aria-label="表示タグ（外部名）"
                        maxlength="1024"
                        placeholder="PLC01.Fast.Tank01.Level"
                      /></label
                    >
                    <button
                      type="button"
                      aria-label="タグを選択"
                      title="候補からタグを選択"
                      disabled={!catalogSelection.available}
                      onclick={openTagPicker}>…</button
                    >
                  </div>
                  <p class="full-width tag-note">
                    {catalogSelection.notice}
                  </p>
                {/if}
                <p class="full-width tag-note">
                  Good
                  で範囲内の値だけを塗ります。取得できない値は灰色の破線、範囲外は橙の枠と矢印で示し、塗りません。
                </p>
              {/if}
              {#if selected.shape.type === "clock"}
                <label class="full-width banto-field banto-field--stacked"
                  ><span class="banto-field-label">表示</span><select
                    class="banto-field-control"
                    name="clockFormat"
                    aria-label="時計の表示"
                    ><option value="date">日付（YYYY/MM/DD）</option><option
                      value="time">時刻（HH:mm）</option
                    ><option value="dateTime">日付と時刻</option></select
                  ></label
                >
                <label class="full-width banto-field banto-field--stacked"
                  ><span class="banto-field-label">秒</span><select
                    class="banto-field-control"
                    name="clockSeconds"
                    aria-label="時計の秒"
                    ><option value="off">秒を出さない</option><option value="on"
                      >秒を出す（HH:mm:ss）</option
                    ></select
                  ></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">文字サイズ</span><input
                    class="banto-field-control"
                    name="clockFontSize"
                    aria-label="時計の文字サイズ"
                    type="text"
                    inputmode="decimal"
                  /></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">文字の太さ</span><select
                    class="banto-field-control"
                    name="clockFontWeight"
                    aria-label="時計の文字の太さ"
                    ><option value="normal">標準</option><option value="bold"
                      >太字</option
                    ></select
                  ></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">文字揃え</span><select
                    class="banto-field-control"
                    name="clockAlign"
                    aria-label="時計の文字揃え"
                    ><option value="left">左</option><option value="center"
                      >中央</option
                    ><option value="right">右</option></select
                  ></label
                >
                <p class="full-width tag-note">
                  端末の現在時刻を1秒ごとに更新します（編集中もプレビューも同じ表示です）。
                </p>
              {/if}
              {#if selected.shape.type === "table"}
                <details class="full-width numeric-hint hint-details">
                  <summary>セルはタブ区切り、行は改行</summary>
                  <p id="inspector-table-help">
                    表計算ソフトの範囲をそのまま貼り付けられます。入力欄の中では
                    Tab でタブを入れ、Shift＋Tab
                    で前の欄へ移ります。列の数は最も長い行に合わせます。色の表は
                    #rrggbb を同じ並びで書き、空のセルは色なしです。{#if activeDefinition}slotを書いたセルは文字の代わりにslotの値（状態の定義があれば状態の文字）を出します。slot名は宣言済みの読取slotだけです。書式は「小数桁;単位」で書き（例:
                      1;℃、2;、;kPa）、slotのあるセルだけに付けます。取得不能の色を書いたセルは状態の色に従い、boolかstateのslotのセルだけに書けます。{:else}タグを書いたセルは文字の代わりにタグの値を出します。書式は「小数桁;単位」で書き（例:
                      1;℃、2;、;kPa）、タグのあるセルだけに付けます。{/if}Ctrl／⌘＋Enter
                    で確定します。
                  </p>
                </details>
                <label class="full-width banto-field banto-field--stacked"
                  ><span class="banto-field-label">セルの文字</span><textarea
                    class="banto-field-control table-grid-input"
                    name="tableText"
                    aria-label="セルの文字"
                    aria-describedby="inspector-table-help"
                    rows="5"
                    wrap="off"
                    oncompositionstart={compositionStart}
                    oncompositionend={compositionEnd}
                    onkeydown={tableAreaKey}></textarea></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">列幅の比</span><input
                    class="banto-field-control"
                    name="tableColumns"
                    aria-label="列幅の比"
                    placeholder="空欄はすべて1（例: 2, 1, 1）"
                  /></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">行の高さの比</span><input
                    class="banto-field-control"
                    name="tableRows"
                    aria-label="行の高さの比"
                    placeholder="空欄はすべて1"
                  /></label
                >
                <label class="full-width banto-field banto-field--stacked"
                  ><span class="banto-field-label">セルの塗り</span><textarea
                    class="banto-field-control table-grid-input"
                    name="tableFills"
                    aria-label="セルの塗り"
                    aria-describedby="inspector-table-help"
                    rows="3"
                    wrap="off"
                    placeholder="空欄は塗りなし（例: #334155）"
                    onkeydown={tableAreaKey}></textarea></label
                >
                <label class="full-width banto-field banto-field--stacked"
                  ><span class="banto-field-label">セルの文字色</span><textarea
                    class="banto-field-control table-grid-input"
                    name="tableColors"
                    aria-label="セルの文字色"
                    aria-describedby="inspector-table-help"
                    rows="3"
                    wrap="off"
                    placeholder="空欄は配置の色"
                    onkeydown={tableAreaKey}></textarea></label
                >
                {#if activeDefinition}
                  <label class="full-width banto-field banto-field--stacked"
                    ><span class="banto-field-label">セルのslot</span><textarea
                      class="banto-field-control table-grid-input"
                      name="tableSlots"
                      aria-label="セルのslot"
                      aria-describedby="inspector-table-help"
                      rows="3"
                      wrap="off"
                      placeholder="空欄は固定の文字（例: running）"
                      onkeydown={tableAreaKey}></textarea></label
                  >
                  <label class="full-width banto-field banto-field--stacked"
                    ><span class="banto-field-label">セルの書式</span><textarea
                      class="banto-field-control table-grid-input"
                      name="tableFormats"
                      aria-label="セルの書式"
                      aria-describedby="inspector-table-help"
                      rows="3"
                      wrap="off"
                      placeholder="小数桁;単位（例: 1;℃）。空欄はそのまま"
                      onkeydown={tableAreaKey}></textarea></label
                  >
                  <label class="full-width banto-field banto-field--stacked"
                    ><span class="banto-field-label">セルの取得不能の色</span
                    ><textarea
                      class="banto-field-control table-grid-input"
                      name="tableUnknownColors"
                      aria-label="セルの取得不能の色"
                      aria-describedby="inspector-table-help"
                      rows="3"
                      wrap="off"
                      placeholder="空欄は状態の色に従わない（例: #64748b）"
                      onkeydown={tableAreaKey}></textarea></label
                  >
                {:else}
                  <label class="full-width banto-field banto-field--stacked"
                    ><span class="banto-field-label">セルのタグ</span><textarea
                      class="banto-field-control table-grid-input"
                      name="tableTags"
                      aria-label="セルのタグ"
                      aria-describedby="inspector-table-help"
                      rows="3"
                      wrap="off"
                      placeholder="空欄は固定の文字（例: PLC01.Tank01.Level）"
                      onkeydown={tableAreaKey}></textarea></label
                  >
                  <label class="full-width banto-field banto-field--stacked"
                    ><span class="banto-field-label">セルの書式</span><textarea
                      class="banto-field-control table-grid-input"
                      name="tableFormats"
                      aria-label="セルの書式"
                      aria-describedby="inspector-table-help"
                      rows="3"
                      wrap="off"
                      placeholder="小数桁;単位（例: 1;℃）。空欄はそのまま"
                      onkeydown={tableAreaKey}></textarea></label
                  >
                {/if}
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">文字サイズ</span><input
                    class="banto-field-control"
                    name="tableFontSize"
                    aria-label="表の文字サイズ"
                    type="text"
                    inputmode="decimal"
                  /></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">文字の太さ</span><select
                    class="banto-field-control"
                    name="tableFontWeight"
                    aria-label="表の文字の太さ"
                    ><option value="normal">標準</option><option value="bold"
                      >太字</option
                    ></select
                  ></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">文字揃え</span><select
                    class="banto-field-control"
                    name="tableAlign"
                    aria-label="表の文字揃え"
                    ><option value="left">左</option><option value="center"
                      >中央</option
                    ><option value="right">右</option></select
                  ></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">罫線</span><select
                    class="banto-field-control"
                    name="tableBorderMode"
                    aria-label="表の罫線"
                    ><option value="line">引く</option><option value="none"
                      >なし</option
                    ></select
                  ></label
                >
                <label
                  >罫線の色<input
                    name="tableBorderColor"
                    aria-label="表の罫線の色"
                    type="color"
                  /></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">罫線の太さ</span><input
                    class="banto-field-control"
                    name="tableBorderWidth"
                    aria-label="表の罫線の太さ"
                    type="text"
                    inputmode="decimal"
                  /></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">地</span><select
                    class="banto-field-control"
                    name="tableBackgroundMode"
                    aria-label="表の地"
                    ><option value="none">透明</option><option value="color"
                      >色で塗る</option
                    ></select
                  ></label
                >
                <label
                  >地の色<input
                    name="tableBackground"
                    aria-label="表の地の色"
                    type="color"
                  /></label
                >
              {/if}
              {#if selected.shape.type === "trend"}
                <label class="full-width banto-field banto-field--stacked"
                  ><span class="banto-field-label">参照するトレンド</span
                  ><select
                    class="banto-field-control"
                    name="trendId"
                    aria-label="参照するトレンド"
                  >
                    {#each project.trends ?? [] as row}<option
                        value={row.id}
                        selected={row.id === selected.shape.trendId}
                        >{row.name}</option
                      >{/each}
                  </select></label
                >
              {/if}
              {#if selected.shape.type === "navButton"}
                <label class="full-width banto-field banto-field--stacked"
                  ><span class="banto-field-label">行き先</span><select
                    class="banto-field-control"
                    name="navTarget"
                    aria-label="画面切替ボタンの行き先"
                    ><option value="">未設定</option>
                    {#each project.screens.filter((s) => !frameScreens.has(s.id)) as target (target.id)}<option
                        value={`screen:${target.id}`}
                        >{target.name}{target.id === screen.id
                          ? "（この画面）"
                          : ""}</option
                      >{/each}
                    <option value="back">戻る（運転表示の履歴）</option>
                    <option value="forward">進む（運転表示の履歴）</option>
                  </select></label
                >
                <label class="full-width banto-field banto-field--stacked"
                  ><span class="banto-field-label">文字</span><input
                    class="banto-field-control"
                    name="navLabel"
                    aria-label="ボタンの文字"
                    type="text"
                    maxlength="200"
                  /></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">文字サイズ</span><input
                    class="banto-field-control"
                    name="navFontSize"
                    aria-label="ボタンの文字サイズ"
                    type="text"
                    inputmode="decimal"
                  /></label
                >
                <label
                  >塗り<input
                    name="navFill"
                    aria-label="ボタンの塗り"
                    type="color"
                  /></label
                >
                <label
                  >文字色<input
                    name="navTextColor"
                    aria-label="ボタンの文字色"
                    type="color"
                  /></label
                >
                <label class="banto-field banto-field--stacked"
                  ><span class="banto-field-label">現在の画面のとき</span
                  ><select
                    class="banto-field-control"
                    name="navCurrentMode"
                    aria-label="現在の画面のときの強調"
                    ><option value="color">色を変える</option><option
                      value="none">通常の色のまま</option
                    ></select
                  ></label
                >
                <label
                  >現在の塗り<input
                    name="navCurrentFill"
                    aria-label="現在の画面のときの塗り"
                    type="color"
                  /></label
                >
                <label
                  >現在の文字色<input
                    name="navCurrentTextColor"
                    aria-label="現在の画面のときの文字色"
                    type="color"
                  /></label
                >
              {/if}
              {#if selected.shape.type === "screenView"}
                <label class="full-width banto-field banto-field--stacked"
                  ><span class="banto-field-label">参照する画面</span><select
                    class="banto-field-control"
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
                  <label class="full-width banto-field banto-field--stacked"
                    ><span class="banto-field-label">関連付ける機器</span
                    ><select
                      class="banto-field-control"
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
                <label class="full-width banto-field banto-field--stacked"
                  ><span class="banto-field-label">参照する Symbol 定義</span
                  ><select
                    class="banto-field-control"
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
            {#if selected.shape.type === "navButton"}
              <p>
                プレビューで押すと行き先の画面へ移ります。編集中は押しても選択だけです。戻る・進むは運転表示（後続）の履歴で使い、プレビューでは押せません。
              </p>
              {#if selected.shape.target?.kind === "screen"}
                <button
                  type="button"
                  onclick={() => {
                    if (
                      selected?.shape.type === "navButton" &&
                      selected.shape.target?.kind === "screen"
                    )
                      openScreen(selected.shape.target.screenId);
                  }}>行き先の画面を開く</button
                >
              {/if}
            {/if}
            {#if selected.shape.type === "trend"}
              <button
                type="button"
                onclick={() => selected && onopentrend?.(selected.id)}
                >履歴を開く</button
              >
              <p>
                定義の変更は参照する全配置へ反映されます。履歴は終了時刻を指定して取得します。
              </p>
              <button
                type="button"
                onclick={() =>
                  selected?.shape.type === "trend" &&
                  onmanagetrend?.(selected.shape.trendId)}
                >参照するトレンド定義を編集</button
              >
              <button
                type="button"
                disabled={(project.trends?.length ?? 0) >= 128}
                onclick={() =>
                  selected &&
                  edit({
                    type: "make-trend-unique",
                    screenId: screen.id,
                    objectId: selected.id,
                  })}>トレンド定義を複製してこの配置に適用</button
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
            <!-- UX精査 P1-2: 長い Inspector でも見えるよう下端に固定し、未適用があるときだけ強調する。 -->
            <div
              class="actions apply-bar"
              class:dirty={drafts.isDirty(objectForm)}
            >
              <button type="submit">変更を適用</button>
              {#if drafts.isDirty(objectForm)}<span class="apply-state"
                  >未適用の変更があります</span
                >{/if}
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
    {#if screenSettings}
      <!-- UX精査 §5.5(b): 未選択時は画面（Symbol 定義）の設定を出す。選択中も消さずに
           隠すだけにして、未適用の入力を保つ。 -->
      <section
        class="screen-settings"
        aria-label={activeDefinition ? "Symbol 設定" : "画面設定"}
        hidden={selectedIds.length > 0 && !showScreenSettings}
      >
        <h2>{activeDefinition ? "Symbol 設定" : "画面設定"}</h2>
        {@render screenSettings()}
      </section>
    {/if}
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
  catalog={catalogSelection.catalog}
  selection={catalogSelection}
  targetLabel={pickerRequest?.label ?? ""}
  onclose={() => (pickerOpen = false)}
  onchoose={chooseTag}
/>

<style>
  .connection-usages {
    padding: 12px 0;
    border-bottom: 1px solid var(--banto-border);
  }
  .connection-usages h3 {
    margin: 0 0 8px;
    font-size: 12px;
  }
  .connection-usages ul {
    padding-left: 16px;
    font-size: 12px;
    line-height: 1.7;
  }
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
  .table-grid-input {
    font-family: ui-monospace, monospace;
    tab-size: 8;
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
  .screen-settings > h2 {
    font-size: 13px;
    margin: 12px 0 6px;
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
  .field-error {
    display: block;
    color: var(--banto-danger, #b42318);
    margin-top: 5px;
    overflow-wrap: anywhere;
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
  .hint-details {
    margin: 8px 0;
    color: var(--banto-text-muted);
  }
  .hint-details > summary {
    cursor: pointer;
    line-height: 1.6;
  }
  .hint-details > summary:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .hint-details > p {
    margin: 4px 0 0;
    font-size: 12px;
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
  .apply-bar {
    position: sticky;
    bottom: 0;
    z-index: 1;
    margin: 12px -14px 0;
    padding: 4px 14px;
    background: var(--banto-surface);
    border-top: 1px solid var(--banto-border);
  }
  .apply-bar button {
    margin: 4px 0;
  }
  .apply-bar.dirty button {
    border-color: var(--banto-primary-solid);
    background: var(--banto-primary-solid);
    color: var(--banto-on-solid);
  }
  .apply-bar.dirty button:hover {
    background: var(--banto-primary-solid-hover);
  }
  .apply-state {
    font-size: 12px;
    color: var(--banto-text-muted);
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
  .flip-toggles {
    display: flex;
    gap: 0.4rem;
    grid-column: 1 / -1;
  }
  .flip-toggle[aria-pressed="true"] {
    color: var(--banto-primary);
    background: var(--banto-surface-hover);
    border-color: var(--banto-primary);
  }
</style>
