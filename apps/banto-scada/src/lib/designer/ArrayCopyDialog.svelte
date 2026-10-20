<script lang="ts">
  import { Modal } from "@banto/ui";
  import { parseNumericProperty } from "./numeric-properties";
  import { validateArrayCopy, type ArrayCopySettings } from "../array-copy";
  let {
    sourceCount,
    existingCount,
    limit,
    stepX,
    stepY,
    onapply,
    onclose,
  }: {
    sourceCount: number;
    existingCount: number;
    limit: number;
    stepX: number;
    stepY: number;
    onapply: (settings: ArrayCopySettings) => string | null;
    onclose: () => void;
  } = $props();
  let error = $state("");
  let composing = $state(false);
  let columns = $state("2"),
    rows = $state("1");
  const added = $derived(
    Number.isInteger(Number(columns)) &&
      Number.isInteger(Number(rows)) &&
      Number(columns) >= 1 &&
      Number(rows) >= 1
      ? sourceCount * (Number(columns) * Number(rows) - 1)
      : null,
  );
  function compositionKey(event: KeyboardEvent) {
    if (
      event.key === "Enter" &&
      (composing || event.isComposing || event.keyCode === 229)
    )
      event.preventDefault();
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (composing) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    try {
      const settings = {
        columns: parseNumericProperty(String(data.get("columns"))),
        rows: parseNumericProperty(String(data.get("rows"))),
        stepX: parseNumericProperty(String(data.get("stepX"))),
        stepY: parseNumericProperty(String(data.get("stepY"))),
      };
      validateArrayCopy(settings, sourceCount, existingCount, limit);
      error = onapply(settings) ?? "";
    } catch (value) {
      error =
        value instanceof Error ? value.message : "配列の設定を確認してください";
    }
  }
</script>

<Modal open title="配列複製" {onclose}>
  <p>
    選択した配置をひと組として、縦横に複製します。行数・列数には元の配置を含みます。
  </p>
  <form
    aria-label="配列複製の設定"
    onsubmit={submit}
    oninput={() => (error = "")}
    oncompositionstart={() => (composing = true)}
    oncompositionend={() => (composing = false)}
  >
    <div class="fields">
      <label
        >列数<input
          name="columns"
          bind:value={columns}
          inputmode="numeric"
          onkeydown={compositionKey}
        /></label
      >
      <label
        >行数<input
          name="rows"
          bind:value={rows}
          inputmode="numeric"
          onkeydown={compositionKey}
        /></label
      >
      <label
        >横の間隔<input
          name="stepX"
          value={stepX}
          inputmode="decimal"
          onkeydown={compositionKey}
        /></label
      >
      <label
        >縦の間隔<input
          name="stepY"
          value={stepY}
          inputmode="decimal"
          onkeydown={compositionKey}
        /></label
      >
    </div>
    <p>
      間隔は元の配置から次の配置への移動量です。負の値も使えます。重なりの自動解消は行いません。
    </p>
    <p aria-live="polite">
      元の{sourceCount}配置 · 追加{added !== null ? added : "—"}配置 ·
      {limit === 100 ? "共有定義内" : "画面内"}の上限{limit}配置
    </p>
    <p>
      機器・タグ・画像原本の参照は共用します。別の機器の新規登録や名称の連番は行いません。
    </p>
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="actions">
      <button type="button" onclick={onclose}>キャンセル</button><button
        type="submit">配列を複製</button
      >
    </div>
  </form>
</Modal>

<style>
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.8rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  input {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    border-radius: 4px;
    font: inherit;
  }
  p {
    max-width: 36rem;
    line-height: 1.65;
  }
  [role="alert"] {
    color: var(--banto-danger, #dc2626);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  button {
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    padding: 7px 14px;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  button[type="submit"] {
    background: var(--banto-primary-solid);
    color: var(--banto-on-solid);
  }
  button[type="submit"]:hover {
    background: var(--banto-primary-solid-hover);
  }
  input:focus-visible,
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
