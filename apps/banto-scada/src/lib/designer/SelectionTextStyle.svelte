<script lang="ts">
  import type { ScreenObject, TextStyle } from "../project";
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
  let size = $state(""),
    weight = $state(""),
    align = $state("");
  let form = $state<HTMLFormElement>();
  let composing = false;
  const texts = $derived(
    objects.flatMap((object) =>
      object.shape.type === "text" ? [object.shape] : [],
    ),
  );
  const eligible = $derived(
    texts.length === objects.length && objects.length > 0,
  );
  function common(field: keyof TextStyle) {
    const values = new Set(texts.map((shape) => shape.style[field]));
    return values.size === 1 ? [...values][0] : null;
  }
  function value(name: string) {
    const field = form?.elements.namedItem(name);
    return field instanceof HTMLInputElement ||
      field instanceof HTMLSelectElement
      ? field.value
      : "";
  }
</script>

{#if texts.length}
  <section aria-label="選択した文字の書式">
    <h3>文字の書式</h3>
    {#if !eligible}<p class="hint">
        Textだけを選択すると編集できます。共有シンボル内部の文字は定義で編集します。
      </p>
    {:else}
      <p>
        現在の文字サイズ：{common("fontSize") ?? "混在"} ／ 太さ：{common(
          "fontWeight",
        ) === null
          ? "混在"
          : common("fontWeight") === "bold"
            ? "太字"
            : "標準"} ／ 揃え：{common("align") === null
          ? "混在"
          : common("align") === "left"
            ? "左"
            : common("align") === "right"
              ? "右"
              : "中央"}
      </p>
      <p class="hint">
        {objects.length} 件に適用{hiddenCount
          ? `・うち非表示 ${hiddenCount} 件`
          : ""}。{definition
          ? "共有定義内のText"
          : "選択したText"}の指定した書式だけを変更します。本文・タグ割付・表示元・枠寸法は保持します。
      </p>
      <form
        bind:this={form}
        use:drafts.track
        data-editor-form="selection-text-style"
        data-target-key={targetKey}
        data-object-ids={JSON.stringify(objectIds)}
        aria-label="選択した文字の書式を変更"
        onreset={() => {
          size = "";
          weight = "";
          align = "";
        }}
        onsubmit={(event) => {
          if (composing) event.preventDefault();
          else {
            onsubmit(event);
            size = value("fontSize");
            weight = value("fontWeight");
            align = value("textAlign");
          }
        }}
      >
        <fieldset disabled={locked}>
          <label
            >適用する文字サイズ<input
              name="fontSize"
              bind:value={size}
              aria-label="適用する文字サイズ"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
              placeholder="変更なし"
              oncompositionstart={() => (composing = true)}
              oncompositionend={() => (composing = false)}
              onkeydown={(event) => {
                if (
                  event.key === "Enter" &&
                  (composing || event.isComposing || event.keyCode === 229)
                )
                  event.preventDefault();
              }}
            /></label
          >
          <div class="choices">
            <label
              >適用する文字の太さ<select
                name="fontWeight"
                bind:value={weight}
                aria-label="適用する文字の太さ"
                ><option value="">変更なし</option><option value="normal"
                  >標準</option
                ><option value="bold">太字</option></select
              ></label
            >
            <label
              >適用する文字揃え<select
                name="textAlign"
                bind:value={align}
                aria-label="適用する文字揃え"
                ><option value="">変更なし</option><option value="left"
                  >左</option
                ><option value="center">中央</option><option value="right"
                  >右</option
                ></select
              ></label
            >
          </div>
          <button type="submit" disabled={!size.trim() && !weight && !align}
            >選択した文字に書式を適用</button
          >
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
  .choices {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 8px 0;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
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
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
    padding: 6px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  button:disabled,
  fieldset:disabled {
    opacity: 0.6;
  }
  button:disabled {
    cursor: default;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
