<script lang="ts">
  import type { ScreenObject, GeometricGroup } from "../project";
  import type { createDraftGuard } from "./drafts.svelte";
  import { unitBounds } from "../geometric-groups";
  let {
    group,
    objects,
    generation,
    screenId,
    locked,
    drafts,
    properties,
  }: {
    group: GeometricGroup;
    objects: ScreenObject[];
    generation: number;
    screenId: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    properties: (event: SubmitEvent) => void;
  } = $props();
  let composing = false;
  function nameKey(event: KeyboardEvent) {
    if (
      event.key === "Enter" &&
      (composing || event.isComposing || event.keyCode === 229)
    )
      event.preventDefault();
  }
  const bounds = $derived.by(() => {
    try {
      return unitBounds(objects);
    } catch {
      return null;
    }
  });
</script>

<section aria-label="グループのプロパティ">
  <h3>{group.name ?? "グループ"} <small>{objects.length} 配置</small></h3>
  <form
    use:drafts.track={{ name: group.name ?? "" }}
    data-editor-form="group-name"
    data-target-key={`${generation}:${screenId}`}
    data-group-id={group.id}
    oncompositionstart={() => (composing = true)}
    oncompositionend={() => (composing = false)}
    onsubmit={(event) => {
      if (composing) {
        event.preventDefault();
        return;
      }
      properties(event);
    }}
  >
    <fieldset disabled={locked}>
      <label
        >グループ名<input
          name="name"
          aria-label="グループ名"
          onkeydown={nameKey}
          value={group.name ?? ""}
          placeholder="グループ"
        /></label
      >
      <button type="submit">グループ名を適用</button>
    </fieldset>
  </form>
  {#if bounds}<dl>
      <dt>X / Y</dt>
      <dd>{bounds.x.toFixed(2)} / {bounds.y.toFixed(2)}</dd>
      <dt>幅 / 高さ</dt>
      <dd>{bounds.width.toFixed(2)} / {bounds.height.toFixed(2)}</dd>
    </dl>{:else}<p>外形を計算できません。</p>{/if}
  <p>
    幅・高さは読取表示です。内部の書式・タグ割付・配置を編集する場合はグループを解除してください。
  </p>
</section>

<style>
  section {
    display: grid;
    gap: 0.7rem;
    margin-bottom: 1rem;
  }
  h3 {
    font-size: 0.9rem;
    margin: 0;
  }
  small {
    font-weight: 400;
    color: var(--banto-text-muted);
  }
  fieldset {
    border: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  label {
    display: grid;
    gap: 0.3rem;
    font-size: 0.8rem;
  }
  input {
    width: 100%;
    box-sizing: border-box;
  }
  input {
    min-height: 36px;
    background: var(--banto-bg);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    padding: 6px;
    border-radius: 4px;
    font: inherit;
  }
  button {
    width: 100%;
    text-align: left;
    padding: 9px 10px;
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    border-radius: 4px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  fieldset:disabled {
    opacity: 0.5;
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  button:focus-visible,
  input:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  dl {
    display: grid;
    grid-template-columns: 6rem 1fr;
    gap: 0.35rem;
    font-size: 0.8rem;
    margin: 0;
  }
  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  p {
    font-size: 0.75rem;
    line-height: 1.6;
    margin: 0;
    opacity: 0.75;
  }
</style>
