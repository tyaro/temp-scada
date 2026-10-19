<script lang="ts">
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
  const lines = $derived(
    objects.flatMap((object) =>
      object.shape.type === "polyline" ? [object.shape] : [],
    ),
  );
  const eligible = $derived(
    lines.length === objects.length && objects.length > 0,
  );
  const widths = $derived(new Set(lines.map((shape) => shape.strokeWidth)));
  const arrows = $derived(new Set(lines.map((shape) => shape.arrow)));
  let width = $state(""),
    arrow = $state("");
  let widthInput = $state<HTMLInputElement>(),
    arrowInput = $state<HTMLSelectElement>();
  let composing = false;
  const specified = $derived(width !== "" || arrow !== "");
  const validWidth = $derived.by(() => {
    if (!width) return true;
    try {
      const value = parseNumericProperty(width);
      return value > 0 && value <= 64;
    } catch {
      return false;
    }
  });
</script>

{#if lines.length > 0}
  <section aria-label="選択した線・配管のスタイル">
    <h3>線・配管のスタイル</h3>
    {#if !eligible}
      <p class="hint">
        線・配管だけを選択すると編集できます。選択内の線だけを暗黙に変更しません。Symbol配置から内部の線は変更できません。
      </p>
    {:else}
      <p class="hint">
        {objects.length} 件に適用{hiddenCount
          ? `・うち非表示 ${hiddenCount} 件`
          : ""}。{definition
          ? "共有定義内の線を変更します。"
          : "選択した線・配管を変更します。"}位置・頂点・色は保持します。
      </p>
      <p class="current">
        現在の線幅：{widths.size === 1 ? [...widths][0] : "混在"} · 矢印：{arrows.size !==
        1
          ? "混在"
          : [...arrows][0] === "end"
            ? "終端"
            : "なし"}
      </p>
      <form
        use:drafts.track
        data-editor-form="selection-line"
        data-target-key={targetKey}
        data-object-ids={JSON.stringify(objectIds)}
        aria-label="選択した線・配管のスタイルを変更"
        onreset={() => {
          width = "";
          arrow = "";
        }}
        onsubmit={(event) => {
          if (composing) event.preventDefault();
          else {
            onsubmit(event);
            width = widthInput?.value ?? "";
            arrow = arrowInput?.value ?? "";
          }
        }}
      >
        <fieldset disabled={locked}>
          <label
            >適用する線幅<input
              bind:this={widthInput}
              bind:value={width}
              name="strokeWidth"
              aria-label="適用する線幅"
              type="text"
              inputmode="decimal"
              placeholder="変更なし（0より大きく64以下）"
              autocomplete="off"
              oncompositionstart={() => (composing = true)}
              oncompositionend={() => (composing = false)}
              onkeydown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.isComposing || composing || event.keyCode === 229)
                )
                  event.preventDefault();
              }}
            /></label
          >
          {#if !validWidth}<p class="hint" role="status">
              線幅は0より大きく64以下の有限の数値で指定してください。空欄は変更なしです。
            </p>{/if}
          <label
            >適用する矢印<select
              bind:this={arrowInput}
              bind:value={arrow}
              name="arrow"
              aria-label="適用する矢印"
              ><option value="">変更なし</option><option value="none"
                >なし</option
              ><option value="end">終端（最後の頂点）</option></select
            ></label
          >
          <p class="hint">
            指定した項目だけ変更します。Enterまたは適用で確定し、フォーカス移動では確定しません。
          </p>
          <button type="submit" disabled={!specified}
            >選択した線・配管に適用</button
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
  input:focus-visible,
  select:focus-visible,
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
