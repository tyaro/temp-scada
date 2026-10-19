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
  let fillType = $state("solid");
  let form: HTMLFormElement;
  let composing = false;
  const values = $derived({
    fillEnabled: String(paint.fill.enabled),
    fillType: paint.fill.paint.type,
    fillColor:
      paint.fill.paint.type === "solid"
        ? paint.fill.paint.color
        : paint.fill.paint.start.color,
    fillAlpha: String(
      (paint.fill.paint.type === "solid"
        ? paint.fill.paint.alpha
        : paint.fill.paint.start.alpha) * 100,
    ),
    fillStartColor:
      paint.fill.paint.type === "solid"
        ? paint.fill.paint.color
        : paint.fill.paint.start.color,
    fillStartAlpha: String(
      (paint.fill.paint.type === "solid"
        ? paint.fill.paint.alpha
        : paint.fill.paint.start.alpha) * 100,
    ),
    fillEndColor:
      paint.fill.paint.type === "solid"
        ? paint.fill.paint.color
        : paint.fill.paint.end.color,
    fillEndAlpha: String(
      (paint.fill.paint.type === "solid"
        ? paint.fill.paint.alpha
        : paint.fill.paint.end.alpha) * 100,
    ),
    fillAngle: String(
      paint.fill.paint.type === "linearGradient" ? paint.fill.paint.angle : 0,
    ),
    strokeEnabled: String(!!paint.stroke),
    strokeColor: paint.stroke?.color ?? "#334155",
    strokeSize: String(paint.stroke?.width ?? 2),
    strokeStyle: paint.stroke?.lineStyle ?? "solid",
    strokeAlpha: String(
      Number(((paint.stroke?.alpha ?? 1) * 100).toPrecision(15)),
    ),
  });
  let initialized = new Set<string>();
  function switchFill() {
    const next = (form.elements.namedItem("fillType") as HTMLSelectElement)
      .value;
    if (!initialized.has(next)) {
      const input = (name: string) =>
        form.elements.namedItem(name) as HTMLInputElement;
      if (next === "linearGradient") {
        for (const end of ["Start", "End"]) {
          input(`fill${end}Color`).value = input("fillColor").value;
          input(`fill${end}Alpha`).value = input("fillAlpha").value;
        }
      } else {
        input("fillColor").value = input("fillStartColor").value;
        input("fillAlpha").value = input("fillStartAlpha").value;
      }
      initialized.add(next);
      form.dispatchEvent(new Event("input", { bubbles: true }));
    }
    sync();
  }
  function sync() {
    const kind = form?.elements.namedItem("fillType");
    fillType = kind instanceof HTMLSelectElement ? kind.value : "solid";
    const select = form?.elements.namedItem("strokeEnabled");
    strokeShown =
      select instanceof HTMLSelectElement && select.value === "true";
  }
  function track(node: HTMLFormElement, next: Record<string, string>) {
    form = node;
    const tracked = drafts.track(node, next);
    initialized = new Set([next.fillType]);
    sync();
    return {
      update(value: Record<string, string>) {
        tracked.update(value);
        initialized = new Set([value.fillType]);
        sync();
      },
      destroy() {
        tracked.destroy();
      },
    };
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (IME Enter guard on the whole explicit paint form) -->
<form
  use:track={values}
  data-editor-form="shape-paint"
  data-object-id={objectId}
  data-target-key={targetKey}
  aria-label="塗りと枠線"
  onreset={() => {
    initialized = new Set([paint.fill.paint.type]);
    sync();
  }}
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
    <label
      >塗りの種類<select
        name="fillType"
        aria-label="塗りの種類"
        onchange={switchFill}
        ><option value="solid">単色</option><option value="linearGradient"
          >線形グラデーション（2色）</option
        ></select
      ></label
    >
    <div class="options" hidden={fillType !== "solid"}>
      <label
        >塗りの色<input
          name="fillColor"
          aria-label="塗りの色"
          type="color"
          disabled={fillType !== "solid"}
        /></label
      >
      <label
        >塗りの不透明度（%）<input
          name="fillAlpha"
          aria-label="塗りの不透明度（%）"
          type="text"
          inputmode="decimal"
          required
          disabled={fillType !== "solid"}
        /></label
      >
    </div>
    <div hidden={fillType !== "linearGradient"}>
      <div class="options">
        <label
          >始点の色<input
            name="fillStartColor"
            aria-label="グラデーションの始点の色"
            type="color"
            disabled={fillType !== "linearGradient"}
          /></label
        >
        <label
          >始点の不透明度（%）<input
            name="fillStartAlpha"
            aria-label="グラデーションの始点の不透明度（%）"
            type="text"
            inputmode="decimal"
            required
            disabled={fillType !== "linearGradient"}
          /></label
        >
      </div>
      <div class="options">
        <label
          >終点の色<input
            name="fillEndColor"
            aria-label="グラデーションの終点の色"
            type="color"
            disabled={fillType !== "linearGradient"}
          /></label
        >
        <label
          >終点の不透明度（%）<input
            name="fillEndAlpha"
            aria-label="グラデーションの終点の不透明度（%）"
            type="text"
            inputmode="decimal"
            required
            disabled={fillType !== "linearGradient"}
          /></label
        >
      </div>
      <label
        >角度（°）<input
          name="fillAngle"
          aria-label="グラデーションの角度"
          type="text"
          inputmode="decimal"
          required
          disabled={fillType !== "linearGradient"}
        /></label
      >
    </div>
    <p>
      単色からグラデーションへの初回切替では両端を現在の色にします。単色への初回切替は始点の色・不透明度を使います。切替済みの入力は適用前まで保持し、塗りなしでも設定を保存します。
    </p>
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
    <div class="options" hidden={!strokeShown}>
      <label
        >枠線の不透明度（%）<input
          name="strokeAlpha"
          aria-label="枠線の不透明度（%）"
          type="number"
          min="0"
          max="100"
          step="any"
          required
          disabled={!strokeShown}
        /></label
      >
    </div>
    <p>
      幅は0より大きく64以下。塗りと枠線の色・不透明度はこのフォームで編集します。設定は適用するまで図面へ反映しません。
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
  [hidden] {
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
