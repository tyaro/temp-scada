<script lang="ts">
  import type { ShapePaint } from "../project";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    paint,
    objectId,
    targetKey,
    locked,
    drafts,
    onsubmit,
  }: {
    paint: ShapePaint;
    objectId: string;
    targetKey: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  let strokeShown = $state(false);
  let form: HTMLFormElement;
  let composing = false;
  const values = $derived({
    fillEnabled: String(paint.fillEnabled),
    strokeEnabled: String(!!paint.stroke),
    strokeColor: paint.stroke?.color ?? "#334155",
    strokeSize: String(paint.stroke?.width ?? 2),
    strokeStyle: paint.stroke?.lineStyle ?? "solid",
  });
  function sync() {
    const select = form?.elements.namedItem("strokeEnabled");
    strokeShown =
      select instanceof HTMLSelectElement && select.value === "true";
  }
  function track(node: HTMLFormElement, next: Record<string, string>) {
    form = node;
    const tracked = drafts.track(node, next);
    sync();
    return {
      update(value: Record<string, string>) {
        tracked.update(value);
        sync();
      },
      destroy() {
        tracked.destroy();
      },
    };
  }
</script>

<form
  use:track={values}
  data-editor-form="shape-paint"
  data-object-id={objectId}
  data-target-key={targetKey}
  aria-label="塗りと枠線"
  onreset={sync}
  oncompositionstart={() => (composing = true)}
  oncompositionend={() => (composing = false)}
  onsubmit={(event) => {
    if (composing) event.preventDefault();
    else onsubmit(event);
  }}
>
  <h3>塗りと枠線</h3>
  <fieldset disabled={locked}>
    <div class="options">
      <label
        >塗り<select name="fillEnabled" aria-label="塗り"
          ><option value="true">あり</option><option value="false">なし</option
          ></select
        ></label
      >
      <label
        >枠線<select name="strokeEnabled" aria-label="枠線" onchange={sync}
          ><option value="false">なし</option><option value="true">あり</option
          ></select
        ></label
      >
    </div>
    <div class="options" hidden={!strokeShown}>
      <label
        >枠線の色<input
          type="color"
          name="strokeColor"
          aria-label="枠線の色"
          disabled={!strokeShown}
        /></label
      >
      <label
        >枠線の幅<input
          type="text"
          inputmode="decimal"
          onkeydown={(event) => {
            if (
              event.key === "Enter" &&
              (composing || event.isComposing || event.keyCode === 229)
            )
              event.preventDefault();
          }}
          name="strokeSize"
          aria-label="枠線の幅"
          disabled={!strokeShown}
          required
        /></label
      >
    </div>
    <div class="options" hidden={!strokeShown}>
      <label
        >枠線の線種<select
          name="strokeStyle"
          aria-label="枠線の線種"
          disabled={!strokeShown}
          ><option value="solid">実線</option><option value="dashed"
            >破線</option
          ><option value="dotted">点線</option></select
        ></label
      >
    </div>
    <p>
      幅は0より大きく64以下。塗りの保存色は下の色欄で編集します。設定は適用するまで図面へ反映しません。
    </p>
    <button type="submit">塗りと枠線を適用</button>
  </fieldset>
</form>

<style>
  form {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--banto-border);
  }
  h3 {
    font-size: 12px;
    margin: 0 0 10px;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  .options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 10px;
  }
  .options[hidden] {
    display: none;
  }
  label {
    display: grid;
    gap: 5px;
    min-width: 0;
    font-size: 12px;
  }
  select,
  input {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 32px;
    padding: 5px;
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    font: inherit;
  }
  input[type="color"] {
    padding: 3px;
  }
  p {
    font-size: 12px;
    color: var(--banto-text-muted);
    line-height: 1.6;
  }
  button {
    padding: 7px 10px;
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  fieldset:disabled {
    opacity: 0.55;
  }
  :is(input, select, button):focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
