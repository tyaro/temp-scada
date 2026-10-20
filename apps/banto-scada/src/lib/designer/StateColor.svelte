<script lang="ts">
  import type { SymbolDefinition, ScreenObject } from "../project";
  import { supportsStateColor, stateColorSources } from "../state-color";
  import { placementLabel } from "../placement-label";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    definition,
    object,
    targetKey,
    locked,
    drafts,
    onsubmit,
    onsource,
  }: {
    definition: SymbolDefinition;
    object: ScreenObject;
    targetKey: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
    onsource: (id: string) => void;
  } = $props();
  const sources = $derived(stateColorSources(definition));
  const current = $derived(
    "stateColor" in object.shape ? object.shape.stateColor?.textId : undefined,
  );
  const supported = $derived(supportsStateColor(object));
</script>

<form
  use:drafts.track={{ stateColorTextId: current ?? "" }}
  data-editor-form="state-color"
  data-object-id={object.id}
  data-target-key={targetKey}
  aria-label="状態表示の色に追従"
  {onsubmit}
>
  <fieldset disabled={locked || !supported}>
    <legend>状態表示の色に追従</legend>
    {#if supported}
      <label
        >配色元Text<select name="stateColorTextId" aria-label="配色元Text"
          ><option value="">追従なし</option
          >{#each sources as source (source.id)}<option value={source.id}
              >{placementLabel(source)} · {source.shape.type === "text"
                ? source.shape.slotBinding?.slotName
                : ""} · {source.id.slice(-6)}</option
            >{/each}</select
        ></label
      >
      {#if !sources.length}<p>
          先にbool slot表示Textで状態別の文字色を設定してください。
        </p>{/if}
      <p>
        塗り／線・矢印の色は配色元と同じ3色を使い、配置の単色より優先します。枠線と各図形の不透明度は保持します。取得状態は図面上部で確認できます。
      </p>
      <button type="submit">状態色の追従を適用</button>
      {#if current}<button type="button" onclick={() => onsource(current!)}
          >配色元Textを選択</button
        >{/if}
    {:else}<p>
        矩形・楕円は有効な単色塗りで設定できます。追従中に塗りを無効化・gradient・patternへ変更するには、先に追従を解除してください。
      </p>{/if}
  </fieldset>
</form>

<style>
  form {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--banto-border);
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  legend {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 10px;
  }
  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  p {
    color: var(--banto-text-muted);
    font-size: 12px;
    line-height: 1.6;
  }
  select,
  button {
    padding: 7px;
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
  }
  select {
    width: 100%;
    min-width: 0;
  }
  button {
    margin-right: 4px;
    margin-bottom: 4px;
  }
  fieldset:disabled {
    opacity: 0.55;
  }
</style>
