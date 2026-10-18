<script lang="ts">
  import { Modal } from "@banto/ui";
  import type { createDraftGuard } from "./drafts.svelte";
  let { guard }: { guard: ReturnType<typeof createDraftGuard> } = $props();
</script>

<Modal
  open={guard.pending}
  title="未適用の入力があります"
  onclose={guard.cancel}
>
  <p>
    {guard.count} 件のフォームに未適用の入力があります。入力を適用するか、破棄して操作を続けてください。
  </p>
  <p>キャンバスのドラッグ操作は、入力の解決後にもう一度行ってください。</p>
  <div class="actions">
    <button onclick={() => guard.apply()}>適用して続行</button>
    <button onclick={() => guard.discard()}>入力を破棄して続行</button>
    <button onclick={guard.cancel}>キャンセル</button>
  </div>
</Modal>

<style>
  p {
    font-size: 14px;
    line-height: 1.7;
    color: var(--banto-text-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button {
    font: inherit;
    font-size: 13px;
    padding: 9px 12px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    color: var(--banto-text);
    background: var(--banto-surface);
    cursor: pointer;
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  button:hover {
    border-color: var(--banto-primary);
  }
</style>
