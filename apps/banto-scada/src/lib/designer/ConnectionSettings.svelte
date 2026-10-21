<script lang="ts">
  import type { ScreenObject, Project } from "../project";
  import {
    CONNECTION_ANCHORS,
    type LineConnections,
    type ConnectionAnchor,
  } from "../connections";
  import { placementLabel } from "../placement-label";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    objectId,
    connections,
    objects,
    project,
    targetKey,
    locked,
    disabledReason,
    drafts,
    onsubmit,
  }: {
    objectId: string;
    connections?: LineConnections;
    objects: readonly ScreenObject[];
    project: Project;
    targetKey: string;
    locked: boolean;
    disabledReason?: string;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  const targets = $derived(objects.filter((o) => o.shape.type === "symbol"));
  const labels: Record<ConnectionAnchor, string> = {
    top: "上",
    right: "右",
    bottom: "下",
    left: "左",
    center: "中心",
  };
  const ends = ["start", "end"] as const;
  let composing = $state(false);
  function composition(event: CompositionEvent, value: boolean) {
    composing = value;
    // Publish synchronously so Apply-and-continue validates before any form commits.
    (event.currentTarget as HTMLSelectElement).form!.dataset.composing =
      String(value);
  }
  function targetLabel(target: ScreenObject) {
    return `${placementLabel(target, project.symbols)} · 配置${target.order + 1}`;
  }
</script>

<section aria-label="配管の接続設定">
  <h3>配管の接続</h3>
  <p>
    Symbolの配置枠へ接続します。移動・回転・サイズ変更に端点が追従し、中間点はその場に残ります。
  </p>
  {#if disabledReason}<p>{disabledReason}</p>{/if}
  {#if !targets.length}<p>この画面に接続先のSymbolがありません。</p>{/if}
  {#each ends as endpoint}
    {@const label = endpoint === "start" ? "始点" : "終点"}
    {@const current = connections?.[endpoint]}
    {@const target = targets.find((o) => o.id === current?.targetObjectId)}
    <form
      use:drafts.track={{
        connectionTarget: current?.targetObjectId ?? "",
        connectionAnchor:
          current?.anchor ?? (endpoint === "start" ? "right" : "left"),
      }}
      data-editor-form="line-connection"
      data-object-id={objectId}
      data-target-key={targetKey}
      data-endpoint={endpoint}
      data-composing={composing}
      aria-label={`${label}の接続`}
      onsubmit={(event) => {
        if (composing) event.preventDefault();
        else onsubmit(event);
      }}
    >
      <fieldset disabled={locked || !!disabledReason || !targets.length}>
        <legend>{label}</legend>
        <p class="current">
          {current && target
            ? `接続中：${targetLabel(target)}／${labels[current.anchor]}`
            : "接続なし"}
        </p>
        <label
          >接続先<select
            oncompositionstart={(event) => composition(event, true)}
            oncompositionend={(event) => composition(event, false)}
            onkeydown={(event) => {
              if (event.key === "Enter" && (composing || event.isComposing))
                event.preventDefault();
            }}
            name="connectionTarget"
            aria-label={`${label}の接続先`}
          >
            <option value="">接続なし（解除）</option>
            {#each targets as item (item.id)}<option value={item.id}
                >{targetLabel(item)}{item.visible === false
                  ? "（非表示）"
                  : ""}</option
              >{/each}
          </select></label
        >
        <label
          >位置<select
            oncompositionstart={(event) => composition(event, true)}
            oncompositionend={(event) => composition(event, false)}
            onkeydown={(event) => {
              if (event.key === "Enter" && (composing || event.isComposing))
                event.preventDefault();
            }}
            name="connectionAnchor"
            aria-label={`${label}の接続位置`}
          >
            {#each CONNECTION_ANCHORS as anchor}<option value={anchor}
                >{labels[anchor]}</option
              >{/each}
          </select></label
        >
        <button type="submit">{label}の接続を適用</button>
      </fieldset>
    </form>
  {/each}
  <p>
    接続端点を直接動かすときは「接続なし（解除）」を適用してください。線だけのコピー・複製は、選択範囲外への接続を外します。
  </p>
</section>

<style>
  section {
    padding: 12px 0;
    border-bottom: 1px solid var(--banto-border);
  }
  h3 {
    margin: 0 0 8px;
    font-size: 12px;
  }
  p {
    font-size: 11px;
    line-height: 1.6;
    color: var(--banto-text-muted);
  }
  .current {
    margin: 4px 0 8px;
  }
  form + form {
    margin-top: 12px;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  legend {
    font-size: 12px;
    font-weight: 600;
  }
  label {
    display: grid;
    gap: 4px;
    margin-bottom: 8px;
    font-size: 12px;
  }
  select,
  button {
    min-width: 0;
    max-width: 100%;
    min-height: 30px;
    padding: 5px;
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
    font: inherit;
    font-size: 12px;
  }
  button {
    cursor: pointer;
  }
  :is(select, button):focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  fieldset:disabled {
    opacity: 0.55;
  }
</style>
