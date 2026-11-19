<script lang="ts">
  import { MAX_BOOL_LABEL_LENGTH } from "./forms/bool-display";
  // Text の「bool の表示」と表のセルの状態表示が共有する入力欄。値は呼び元の
  // フォームの下書き（drafts.track）が入れ、name は呼び元が決める。
  let {
    name = (key: string) => key,
    form,
    onmodechange,
  }: {
    /** フォームの項目名（表のセルごとに別の名前にする）。 */
    name?: (key: string) => string;
    /** 欄の form 属性（表のセルの欄は囲むフォームに属させず、値を呼び元が出し入れする）。 */
    form?: string;
    onmodechange?: (
      event: Event & { currentTarget: HTMLSelectElement },
    ) => void;
  } = $props();
</script>

<label class="banto-field banto-field--stacked"
  ><span class="banto-field-label">使用</span><select
    class="banto-field-control"
    {form}
    name={name("boolDisplayMode")}
    aria-label="bool の表示を使う"
    onchange={onmodechange}
    ><option value="disabled">使用しない</option><option value="enabled"
      >使用する</option
    ></select
  ></label
>
<div class="rows">
  <label
    >true の文字<input
      {form}
      name={name("trueText")}
      aria-label="true の文字"
      maxlength={MAX_BOOL_LABEL_LENGTH}
    /></label
  >
  <label
    >色<input
      type="color"
      {form}
      name={name("trueColor")}
      aria-label="true の色"
    /></label
  >
  <label
    >false の文字<input
      {form}
      name={name("falseText")}
      aria-label="false の文字"
      maxlength={MAX_BOOL_LABEL_LENGTH}
    /></label
  >
  <label
    >色<input
      type="color"
      {form}
      name={name("falseColor")}
      aria-label="false の色"
    /></label
  >
  <label class="wide"
    >取得不能の色<input
      type="color"
      {form}
      name={name("unknownColor")}
      aria-label="取得不能の色"
    /></label
  >
</div>

<style>
  .rows {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    gap: 8px;
    margin-top: 10px;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .rows label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  select,
  input {
    width: 100%;
    min-width: 0;
    padding: 7px;
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
  }
  input[type="color"] {
    height: 30px;
    padding: 2px;
  }
</style>
