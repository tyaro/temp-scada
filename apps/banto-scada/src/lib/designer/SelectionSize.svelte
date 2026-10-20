<script lang="ts">
  import type { ScreenObject } from "../project";
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
  let width = $state(""),
    height = $state("");
  let form = $state<HTMLFormElement>();
  let composing = false;
  const supported = $derived(objects.every((o) => "width" in o));
  function common(field: "width" | "height") {
    const first = objects[0];
    if (
      !first ||
      !("width" in first) ||
      !objects.every((o) => "width" in o && o[field] === first[field])
    )
      return "混在";
    return String(first[field]);
  }
</script>

<form
  bind:this={form}
  use:drafts.track
  data-editor-form="selection-size"
  data-target-key={targetKey}
  data-object-ids={JSON.stringify(objectIds)}
  aria-label="選択した配置の幅・高さ"
  onreset={() => {
    width = "";
    height = "";
  }}
  onsubmit={(event) => {
    if (composing) event.preventDefault();
    else {
      onsubmit(event);
      width =
        (form?.elements.namedItem("width") as HTMLInputElement)?.value ?? "";
      height =
        (form?.elements.namedItem("height") as HTMLInputElement)?.value ?? "";
    }
  }}
>
  <h3>幅・高さを統一</h3>
  <p>現在の幅：{common("width")} ／ 高さ：{common("height")}</p>
  <p class="hint">
    {objects.length} 件に適用{hiddenCount
      ? `・うち非表示 ${hiddenCount} 件`
      : ""}。{definition
      ? "共有定義内の配置"
      : "各配置"}の中心・回転を保ち、ローカル枠寸法を揃えます。空欄の寸法は変更しません。
  </p>
  {#if !supported}<p class="hint" role="status">
      線・配管を含むためサイズを統一できません。対象を選び直してください。
    </p>{/if}
  <fieldset disabled={locked || !supported}>
    <div class="dimensions">
      {#each ["width", "height"] as field}
        <label
          >{field === "width" ? "適用する幅" : "適用する高さ"}<input
            name={field}
            aria-label={field === "width" ? "適用する幅" : "適用する高さ"}
            value={field === "width" ? width : height}
            oninput={(event) => {
              if (field === "width") width = event.currentTarget.value;
              else height = event.currentTarget.value;
            }}
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
      {/each}
    </div>
    <p class="hint">
      回転後の外接寸法や画像内容の幅を揃える操作ではありません。Imageのfit・crop、Symbolや埋込画面の参照を保持します。
    </p>
    <button type="submit" disabled={!width.trim() && !height.trim()}
      >選択した配置にサイズを適用</button
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
  .dimensions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
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
</style>
