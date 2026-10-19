<script lang="ts">
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    current,
    count,
    imageCount = 0,
    gradientCount = 0,
    definitionColorCount = 0,
    paintDisabledCount = 0,
    hiddenCount,
    locked,
    definition,
    targetKey,
    objectIds,
    drafts,
    onsubmit,
  }: {
    current: string | null;
    count: number;
    imageCount?: number;
    gradientCount?: number;
    definitionColorCount?: number;
    paintDisabledCount?: number;
    hiddenCount: number;
    locked: boolean;
    definition: boolean;
    targetKey: string;
    objectIds: string[];
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  let convert = $state(false);
  let convertInput = $state<HTMLInputElement>();
  let code = $state("");
  let input = $state<HTMLInputElement>();
  let composing = false;
  const valid = $derived(/^#[0-9a-fA-F]{6}$/.test(code));
  const presets = [
    { name: "黒", value: "#000000" },
    { name: "白", value: "#ffffff" },
    { name: "青", value: "#2563eb" },
    { name: "水色", value: "#0891b2" },
    { name: "緑", value: "#16a34a" },
    { name: "橙", value: "#ea580c" },
  ];
  function choose(value: string) {
    if (!input || locked) return;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
</script>

<form
  use:drafts.track
  data-editor-form="selection-color"
  data-target-key={targetKey}
  data-object-ids={JSON.stringify(objectIds)}
  aria-label="選択した配置の色"
  onreset={() => {
    code = "";
    convert = false;
  }}
  onsubmit={(event) => {
    if (composing) event.preventDefault();
    else {
      onsubmit(event);
      code = input?.value ?? "";
      convert = convertInput?.checked ?? false;
    }
  }}
>
  <h3>選択した配置の色</h3>
  <p class="current-color">
    <span
      class="chip"
      class:mixed={!current || definitionColorCount > 0}
      style:background={definitionColorCount
        ? undefined
        : (current ?? undefined)}
      aria-hidden="true"
    ></span>
    現在の色：{definitionColorCount
      ? `共有定義の色を使うSymbol ${definitionColorCount} 件を含みます`
      : (current ?? "混在")}
  </p>
  <p class="hint">
    {count} 件に適用{hiddenCount
      ? `・うち非表示 ${hiddenCount} 件`
      : ""}。{definition
      ? "共有定義内の図形・文字・線を変更します。配置の単色指定は維持します。"
      : "図形・文字・線・Symbol配置の単色を変更します。共有定義は変わりません。"}
  </p>
  {#if paintDisabledCount}<p class="hint" role="status">
      塗りと枠線が無効の配置を{paintDisabledCount}件含みます。有効にしてから適用してください。
    </p>{/if}
  {#if imageCount}<p class="hint" role="status">
      画像を含む選択には色を適用できません。画像以外だけを選択してください。
    </p>{/if}
  {#if gradientCount}<p class="hint" role="status">
      グラデーションを含む選択には共通色を適用できません。単独の塗り設定で編集してください。
    </p>{/if}
  <fieldset
    disabled={locked ||
      paintDisabledCount > 0 ||
      imageCount > 0 ||
      gradientCount > 0}
  >
    <label
      >適用する色<input
        bind:this={input}
        bind:value={code}
        name="fill"
        aria-label="適用する色"
        placeholder="#RRGGBB（空欄は変更なし）"
        pattern={"#[0-9a-fA-F]{6}"}
        maxlength="7"
        autocomplete="off"
        spellcheck="false"
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
    <div class="presets" role="group" aria-label="配色候補">
      {#each presets as preset}
        <button
          type="button"
          title={`${preset.name} ${preset.value}`}
          onclick={() => choose(preset.value)}
        >
          <span class="chip" style:background={preset.value} aria-hidden="true"
          ></span>{preset.name}<small>{preset.value}</small>
        </button>
      {/each}
    </div>
    {#if code}
      <p class="hint" role="status">
        {#if valid}<span class="chip" style:background={code} aria-hidden="true"
          ></span>適用する色：{code}
        {:else}#と6桁の16進数で入力してください。例：#2563eb{/if}
      </p>
    {/if}
    {#if definitionColorCount}<label class="convert"
        ><input
          type="checkbox"
          name="convertDefinitionSymbols"
          bind:this={convertInput}
          bind:checked={convert}
        />共有定義の色を使うSymbol {definitionColorCount} 件を配置単色へ切り替える（保存された単色の不透明度も適用）</label
      >{/if}
    <button
      type="submit"
      disabled={!code || (definitionColorCount > 0 && !convert)}
      >選択した配置に色を適用</button
    >
  </fieldset>
</form>

<style>
  form {
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
  .chip {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 1px solid var(--banto-border);
    vertical-align: middle;
    margin-right: 5px;
  }
  .mixed {
    background: repeating-linear-gradient(
      135deg,
      var(--banto-surface) 0 4px,
      var(--banto-border) 4px 6px
    );
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
  input {
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
  input:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .convert {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 12px 0;
    line-height: 1.6;
  }
  .convert input {
    width: auto;
    padding: 0;
    flex-shrink: 0;
    margin-top: 3px;
  }
  .presets {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 5px;
    margin: 8px 0;
  }
  .presets button {
    text-align: left;
    padding: 4px;
  }
  small {
    display: block;
    color: var(--banto-text-muted);
    font-size: 10px;
    padding-left: 19px;
  }
</style>
