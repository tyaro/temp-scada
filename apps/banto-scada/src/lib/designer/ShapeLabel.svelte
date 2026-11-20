<script lang="ts">
  import { isAreaShape, type ScreenObject } from "../project";
  import { shapeLabelFormValues } from "./forms/shape-label";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    object,
    background,
    targetKey,
    locked,
    drafts,
    onsubmit,
  }: {
    object: ScreenObject;
    background: string;
    targetKey: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  // 面の図形の中の文字（#305 L2）。塗り・状態色と同じく独立した draft を持つ。
  const values = $derived(shapeLabelFormValues(object, background));
  const hasLabel = $derived(isAreaShape(object.shape) && !!object.shape.label);
  let composing = false;
  /** Text の文言の欄と同じ: Enter は改行、Ctrl／⌘＋Enter で確定。IME 変換中は確定しない。 */
  function textAreaKey(event: KeyboardEvent) {
    if (
      event.key !== "Enter" ||
      !(event.ctrlKey || event.metaKey) ||
      event.altKey
    )
      return;
    event.preventDefault();
    if (composing || event.isComposing || event.keyCode === 229) return;
    (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
  }
  /** 数値の欄は既存の数値の欄と同じく blur でも確定する（文字がある間だけ。無い間は文言の確定で入る）。 */
  function blurSize(event: FocusEvent) {
    const input = event.currentTarget as HTMLInputElement;
    if (
      composing ||
      locked ||
      drafts.pending ||
      !hasLabel ||
      !input.isConnected ||
      input.value === values.labelFontSize
    )
      return;
    input.form?.requestSubmit();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (IME Enter guard on the whole label form) -->
<form
  use:drafts.track={values}
  data-editor-form="shape-label"
  data-object-id={object.id}
  data-target-key={targetKey}
  aria-label="図形の文字"
  oncompositionstart={() => (composing = true)}
  oncompositionend={() => (composing = false)}
  onkeydown={(event) => {
    if (
      event.key === "Enter" &&
      (composing || event.isComposing || event.keyCode === 229)
    )
      event.preventDefault();
  }}
  onsubmit={(event) => {
    if (composing) event.preventDefault();
    else onsubmit(event);
  }}
>
  <h3>文字</h3>
  <fieldset disabled={locked}>
    <label class="banto-field banto-field--stacked"
      ><span class="banto-field-label">文言</span><textarea
        class="banto-field-control"
        name="labelText"
        aria-label="図形の文言"
        aria-describedby="shape-label-help"
        rows="3"
        wrap="off"
        onkeydown={textAreaKey}></textarea></label
    >
    <div class="options">
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">文字サイズ</span><input
          class="banto-field-control"
          name="labelFontSize"
          aria-label="図形の文字サイズ"
          type="text"
          inputmode="decimal"
          required
          onblur={blurSize}
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">文字の太さ</span><select
          class="banto-field-control"
          name="labelFontWeight"
          aria-label="図形の文字の太さ"
          ><option value="normal">標準</option><option value="bold">太字</option
          ></select
        ></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">文字揃え</span><select
          class="banto-field-control"
          name="labelAlign"
          aria-label="図形の文字揃え"
          ><option value="left">左</option><option value="center">中央</option
          ><option value="right">右</option></select
        ></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">折返し</span><select
          class="banto-field-control"
          name="labelWrap"
          aria-label="図形の文字の折返し"
          ><option value="none">折返しなし</option><option value="word"
            >枠幅で折返し</option
          ></select
        ></label
      >
      <label
        >文字色<input
          name="labelColor"
          aria-label="図形の文字色"
          type="color"
        /></label
      >
    </div>
    <p id="shape-label-help">
      Enter で改行、Ctrl／⌘＋Enter
      か「文字を適用」で確定します。文言を空にして確定すると文字を消します。{hasLabel
        ? ""
        : "書式は文言と一緒に入ります。"}
    </p>
    <button type="submit">文字を適用</button>
  </fieldset>
</form>

<style>
  form {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--banto-border);
  }
  h3 {
    font-size: 13px;
    margin: 0 0 10px;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
    display: grid;
    gap: 8px;
  }
  .options {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  textarea {
    resize: vertical;
    font: inherit;
  }
  p {
    color: var(--banto-text-muted);
    font-size: 12px;
    line-height: 1.6;
    margin: 0;
  }
  button {
    justify-self: start;
    padding: 7px;
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
  }
  fieldset:disabled {
    opacity: 0.55;
  }
</style>
