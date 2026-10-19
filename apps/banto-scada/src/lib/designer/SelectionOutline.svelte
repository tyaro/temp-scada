<script lang="ts">
  import { tick } from "svelte";
  import type { ScreenObject } from "../project";
  import { parseNumericProperty } from "./numeric-properties";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    objects,
    hiddenCount,
    locked,
    definition,
    targetKey,
    objectIds,
    drafts,
    onsubmit,
  }: {
    objects: ScreenObject[];
    hiddenCount: number;
    locked: boolean;
    definition: boolean;
    targetKey: string;
    objectIds: string[];
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  const shapes = $derived(
    objects.flatMap((object) =>
      object.shape.type === "rectangle" || object.shape.type === "ellipse"
        ? [object.shape]
        : [],
    ),
  );
  const eligible = $derived(
    shapes.length === objects.length && shapes.length > 0,
  );
  const outlines = $derived(
    shapes.flatMap((shape) => (shape.paint.stroke ? [shape.paint.stroke] : [])),
  );
  const absent = $derived(shapes.length - outlines.length);
  const colors = $derived(
    new Set(outlines.map((outline) => outline.color.toLowerCase())),
  );
  const widths = $derived(new Set(outlines.map((outline) => outline.width)));
  let mode = $state(""),
    code = $state(""),
    width = $state("");
  let modeInput = $state<HTMLSelectElement>(),
    colorInput = $state<HTMLInputElement>(),
    widthInput = $state<HTMLInputElement>();
  let composing = false;
  const specified = $derived(mode !== "" || code !== "" || width !== "");
  const contradiction = $derived(
    mode === "none" && (code !== "" || width !== ""),
  );
  const needEnabled = $derived(
    mode === "" && absent > 0 && (code !== "" || width !== ""),
  );
  const needBoth = $derived(
    mode === "enabled" && absent > 0 && (code === "" || width === ""),
  );
  const validColor = $derived(
    code === "" || /^#[0-9a-fA-F]{6}$/.test(code.trim()),
  );
  const validWidth = $derived.by(() => {
    if (width === "") return true;
    try {
      const value = parseNumericProperty(width);
      return value > 0 && value <= 64;
    } catch {
      return false;
    }
  });
  function sync() {
    mode = modeInput?.value ?? "";
    code = colorInput?.value ?? "";
    width = widthInput?.value ?? "";
  }
  async function reset() {
    mode = "";
    code = "";
    width = "";
    await tick();
    modeInput?.form?.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function compositionKey(event: KeyboardEvent) {
    if (
      event.key === "Enter" &&
      (composing || event.isComposing || event.keyCode === 229)
    )
      event.preventDefault();
  }
</script>

{#if shapes.length > 0}
  <section aria-label="選択した矩形・楕円の枠線">
    <h3>矩形・楕円の枠線</h3>
    {#if !eligible}
      <p class="hint">
        矩形・楕円だけを選択すると枠線を編集できます。対応する図形だけを暗黙に変更しません。Symbol配置から内部の枠線は変更できません。
      </p>
    {:else}
      <p class="hint">
        {objects.length}件に適用{hiddenCount
          ? `・うち非表示 ${hiddenCount} 件`
          : ""}。{definition
          ? "共有定義内の図形を変更し、参照する全配置へ反映します。"
          : "塗り・位置・本体寸法は保持します。"}
      </p>
      <p class="current">
        枠線あり {outlines.length} 件・なし {absent} 件<br />
        現在の色：{!outlines.length
          ? "なし"
          : colors.size === 1
            ? [...colors][0]
            : "混在"} · 幅：{!outlines.length
          ? "なし"
          : widths.size === 1
            ? [...widths][0]
            : "混在"}
      </p>
      <form
        use:drafts.track
        data-editor-form="selection-outline"
        data-target-key={targetKey}
        data-object-ids={JSON.stringify(objectIds)}
        aria-label="選択した矩形・楕円の枠線を変更"
        onreset={reset}
        onsubmit={(event) => {
          if (composing) event.preventDefault();
          else {
            onsubmit(event);
            sync();
          }
        }}
      >
        <fieldset disabled={locked}>
          <label
            >適用する枠線<select
              bind:this={modeInput}
              bind:value={mode}
              name="outlineMode"
              aria-label="適用する枠線"
              ><option value="">変更なし</option><option value="none"
                >なし</option
              ><option value="enabled">あり</option></select
            ></label
          >
          <label
            >適用する枠線色<input
              bind:this={colorInput}
              bind:value={code}
              name="outlineColor"
              aria-label="適用する枠線色"
              placeholder="変更なし（#RRGGBB）"
              autocomplete="off"
              spellcheck="false"
              oncompositionstart={() => (composing = true)}
              oncompositionend={() => (composing = false)}
              onkeydown={compositionKey}
            /></label
          >
          <label
            >適用する枠線幅<input
              bind:this={widthInput}
              bind:value={width}
              name="outlineWidth"
              aria-label="適用する枠線幅"
              inputmode="decimal"
              placeholder="変更なし（0より大きく64以下）"
              autocomplete="off"
              oncompositionstart={() => (composing = true)}
              oncompositionend={() => (composing = false)}
              onkeydown={compositionKey}
            /></label
          >
          {#if contradiction}<p class="hint" role="status">
              枠線なしと色・幅は同時に指定できません。色・幅の指定を空欄に戻してください。
            </p>{/if}
          {#if needEnabled || needBoth}<p class="hint" role="status">
              枠線なしの配置を含みます。新設するには「あり」と色・幅の両方を指定してください。指定値は既存の枠線にも適用します。
            </p>{/if}
          {#if !validColor}<p class="hint" role="status">
              枠線色は#と6桁の16進数で指定してください。空欄は変更なしです。
            </p>{/if}
          {#if !validWidth}<p class="hint" role="status">
              枠線幅は0より大きく64以下の有限の数値で指定してください。空欄は変更なしです。
            </p>{/if}
          <p class="hint">
            指定した項目だけ変更します。色・幅の現在値は枠線ありの対象だけを集計しています。Enterまたは適用で確定し、フォーカス移動では確定しません。
          </p>
          <button
            type="submit"
            disabled={!specified || contradiction || needEnabled || needBoth}
            >選択した矩形・楕円の枠線に適用</button
          >
          <button type="reset" disabled={!specified}>指定を解除</button>
        </fieldset>
      </form>
    {/if}
  </section>
{/if}

<style>
  section {
    border-top: 1px solid var(--banto-border);
    padding-top: 12px;
    margin-top: 16px;
  }
  h3 {
    font-size: 13px;
    margin: 0 0 8px;
  }
  p {
    font-size: 12px;
    line-height: 1.6;
  }
  .hint {
    color: var(--banto-text-muted);
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
    display: grid;
    gap: 10px;
  }
  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  input,
  select {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    padding: 7px;
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
    font: inherit;
  }
  button {
    padding: 7px 10px;
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  button:disabled,
  fieldset:disabled {
    opacity: 0.55;
  }
  :is(input, select, button):focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
