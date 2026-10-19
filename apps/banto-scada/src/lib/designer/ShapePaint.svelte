<script lang="ts">
  import { tick } from "svelte";
  import Primitive from "../Primitive.svelte";
  import {
    paintBaseColor,
    type ShapePaint,
    type FillPaint,
    type LayoutObject,
  } from "../project";
  import { patternFromForm } from "./pattern-fields";
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
  let patternKind = $state("hatch");
  let backgroundShown = $state(false);
  let patternPreview = $state<Extract<FillPaint, { type: "pattern" }> | null>(
    null,
  );
  let previewError = $state("");
  const previewObject = $derived(
    patternPreview
      ? ({
          id: "pattern-preview",
          order: 0,
          x: 0,
          y: 0,
          rotation: 0,
          width: 160,
          height: 56,
          shape: {
            type: "rectangle",
            paint: {
              fill: { enabled: true, paint: patternPreview },
              stroke: null,
            },
          },
        } satisfies LayoutObject)
      : null,
  );
  let form: HTMLFormElement;
  let composing = false;
  const base = $derived(paintBaseColor(paint.fill.paint));
  const savedPattern = $derived(
    paint.fill.paint.type === "pattern" ? paint.fill.paint : null,
  );
  const percent = (value: number) =>
    String(Number((value * 100).toPrecision(15)));
  const values = $derived({
    fillEnabled: String(paint.fill.enabled),
    fillType: paint.fill.paint.type,
    fillColor: base.color,
    fillAlpha: percent(base.alpha),
    fillStartColor: base.color,
    fillStartAlpha: percent(base.alpha),
    fillEndColor:
      paint.fill.paint.type === "linearGradient"
        ? paint.fill.paint.end.color
        : base.color,
    fillEndAlpha: percent(
      paint.fill.paint.type === "linearGradient"
        ? paint.fill.paint.end.alpha
        : base.alpha,
    ),
    patternKind: savedPattern?.kind ?? "hatch",
    patternSpacing: String(savedPattern?.spacing ?? 12),
    patternSize: String(savedPattern?.size ?? 1),
    patternAngle: String(savedPattern?.angle ?? 45),
    patternForegroundColor: base.color,
    patternForegroundAlpha: percent(base.alpha),
    patternBackgroundEnabled: String(!!savedPattern?.background),
    patternBackgroundColor: savedPattern?.background?.color ?? "#ffffff",
    patternBackgroundAlpha: percent(savedPattern?.background?.alpha ?? 1),
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
  let patternDimensions = new Map<string, { size: string; angle: string }>();
  let modelKey = "";
  const input = (name: string) =>
    form.elements.namedItem(name) as HTMLInputElement;
  function switchFill() {
    const next = input("fillType").value;
    if (!initialized.has(next)) {
      const source =
        fillType === "linearGradient"
          ? "fillStart"
          : fillType === "pattern"
            ? "patternForeground"
            : "fill";
      const color = input(`${source}Color`).value,
        alpha = input(`${source}Alpha`).value;
      const destinations =
        next === "linearGradient"
          ? ["fillStart", "fillEnd"]
          : next === "pattern"
            ? ["patternForeground"]
            : ["fill"];
      for (const prefix of destinations) {
        input(`${prefix}Color`).value = color;
        input(`${prefix}Alpha`).value = alpha;
      }
      initialized.add(next);
      form.dispatchEvent(new Event("input", { bubbles: true }));
    }
    sync();
  }
  function switchPattern() {
    patternDimensions.set(patternKind, {
      size: input("patternSize").value,
      angle: input("patternAngle").value,
    });
    const next = input("patternKind").value;
    const settings = patternDimensions.get(next) ?? {
      size: next === "dots" ? "3" : "1",
      angle: next === "dots" ? "0" : "45",
    };
    input("patternSize").value = settings.size;
    input("patternAngle").value = settings.angle;
    form.dispatchEvent(new Event("input", { bubbles: true }));
    sync();
  }
  async function refreshPreview() {
    await tick();
    if (!form?.isConnected) return;
    if (fillType !== "pattern") {
      patternPreview = null;
      previewError = "";
      return;
    }
    try {
      patternPreview = locked
        ? savedPattern
        : patternFromForm(new FormData(form));
      previewError = "";
    } catch (error) {
      patternPreview = null;
      previewError =
        error instanceof Error ? error.message : "入力を確認してください。";
    }
  }
  function resetKinds(next: Record<string, string>) {
    initialized = new Set([next.fillType]);
    patternDimensions = new Map([
      [next.patternKind, { size: next.patternSize, angle: next.patternAngle }],
    ]);
    modelKey = JSON.stringify(next);
  }
  function sync() {
    patternKind = input("patternKind").value;
    backgroundShown = input("patternBackgroundEnabled").value === "true";
    void refreshPreview();
    const kind = form?.elements.namedItem("fillType");
    fillType = kind instanceof HTMLSelectElement ? kind.value : "solid";
    const select = form?.elements.namedItem("strokeEnabled");
    strokeShown =
      select instanceof HTMLSelectElement && select.value === "true";
  }
  function track(node: HTMLFormElement, next: Record<string, string>) {
    form = node;
    const tracked = drafts.track(node, next);
    resetKinds(next);
    sync();
    return {
      update(value: Record<string, string>) {
        tracked.update(value);
        if (modelKey !== JSON.stringify(value)) resetKinds(value);
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
    resetKinds(values);
    sync();
  }}
  oninput={() => {
    void refreshPreview();
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
        ><option value="pattern">パターン（模様）</option></select
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
    <div hidden={fillType !== "pattern"}>
      <label
        >模様<select
          name="patternKind"
          aria-label="模様の種類"
          disabled={fillType !== "pattern"}
          onchange={switchPattern}
          ><option value="hatch">斜線</option><option value="crosshatch"
            >交差線</option
          ><option value="dots">点</option></select
        ></label
      >
      <div class="options">
        <label
          >間隔<input
            name="patternSpacing"
            aria-label="模様の間隔"
            type="text"
            inputmode="decimal"
            required
            disabled={fillType !== "pattern"}
          /></label
        >
        <label
          >{patternKind === "dots" ? "点の直径" : "線の太さ"}<input
            name="patternSize"
            aria-label="模様の太さ"
            type="text"
            inputmode="decimal"
            required
            disabled={fillType !== "pattern"}
          /></label
        >
      </div>
      <label
        >線／格子の角度（°）<input
          name="patternAngle"
          aria-label="模様の角度"
          type="text"
          inputmode="decimal"
          required
          disabled={fillType !== "pattern"}
        /></label
      >
      <div class="options">
        <label
          >模様の色<input
            name="patternForegroundColor"
            aria-label="模様の色"
            type="color"
            disabled={fillType !== "pattern"}
          /></label
        >
        <label
          >不透明度（%）<input
            name="patternForegroundAlpha"
            aria-label="模様の不透明度（%）"
            type="text"
            inputmode="decimal"
            required
            disabled={fillType !== "pattern"}
          /></label
        >
      </div>
      <label
        >背景<select
          name="patternBackgroundEnabled"
          aria-label="模様の背景"
          onchange={sync}
          disabled={fillType !== "pattern"}
          ><option value="false">透明</option><option value="true"
            >色を指定</option
          ></select
        ></label
      >
      <div class="options" hidden={!backgroundShown}>
        <label
          >背景の色<input
            name="patternBackgroundColor"
            aria-label="模様の背景色"
            type="color"
            disabled={fillType !== "pattern" || !backgroundShown}
          /></label
        >
        <label
          >不透明度（%）<input
            name="patternBackgroundAlpha"
            aria-label="模様の背景の不透明度（%）"
            type="text"
            inputmode="decimal"
            required
            disabled={fillType !== "pattern" || !backgroundShown}
          /></label
        >
      </div>
      {#if previewObject}<svg
          class="pattern-preview"
          viewBox="0 0 160 56"
          role="img"
          aria-label="模様の見本（未適用）"
          ><Primitive object={previewObject} /></svg
        >{:else}<p class="preview-error">見本：{previewError}</p>{/if}
      <p>
        間隔は線や点の中心間距離。太さは間隔の半分以下です。見本は未適用の入力を表示します。
      </p>
    </div>
    <p>
      種類への初回切替は、単色・グラデーションの始点・模様の色を引き継ぎます。切替済みの入力は適用前まで保持し、塗りなしでも設定を保存します。
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
  .pattern-preview {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 160 / 56;
    border: 1px solid var(--banto-border);
    background-color: #fff;
    background-image: conic-gradient(
      #cbd5e1 25%,
      transparent 0 50%,
      #cbd5e1 0 75%,
      transparent 0
    );
    background-size: 12px 12px;
  }
  .preview-error {
    min-height: 56px;
  }

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
