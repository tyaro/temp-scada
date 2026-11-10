<script lang="ts">
  import { onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { Modal } from "@banto/ui";
  import { createCloseConfirmation, type CloseView } from "./close";

  // The confirmation before the window closes (product-owner design §6.1).
  let view = $state<CloseView>();
  const confirmation = createCloseConfirmation(
    invoke,
    listen,
    (next) => (view = next),
  );
  onDestroy(() => confirmation.dispose());
</script>

<Modal
  open={view?.kind === "candidate"}
  title="終了の確認"
  width="420px"
  onclose={() => void confirmation.answer("cancel")}
>
  <div class="close-confirm">
    <p>未完了の変更候補があります。破棄して終了しますか。</p>
    <p class="note">
      キャンセルすると終了しません。記録操作の画面で候補を適用するか破棄できます。
    </p>
    <div class="actions">
      <button
        type="button"
        class="danger"
        onclick={() => void confirmation.answer("discard")}>破棄して終了</button
      >
      <button type="button" onclick={() => void confirmation.answer("cancel")}
        >キャンセル</button
      >
    </div>
  </div>
</Modal>

<Modal
  open={view?.kind === "waiting" || view?.kind === "discarding"}
  title="終了しています"
  width="420px"
  closeOnOverlayClick={false}
  onRequestClose={() => false}
>
  <p class="close-confirm" role="status">
    {view?.kind === "discarding"
      ? "変更候補を破棄して終了します。"
      : "記録の操作が終わるまで待って終了します。"}
  </p>
</Modal>

<style>
  .close-confirm {
    display: grid;
    gap: 10px;
    margin: 0;
    font-size: 13px;
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .note {
    color: var(--banto-text-muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  button {
    padding: 4px 10px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    background: var(--banto-bg);
    color: var(--banto-text);
    font: inherit;
  }
  button.danger {
    border-color: var(--banto-danger, #b42318);
    color: var(--banto-danger, #b42318);
  }
</style>
