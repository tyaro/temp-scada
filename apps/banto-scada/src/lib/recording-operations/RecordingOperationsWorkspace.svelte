<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Modal } from "@banto/ui";
  import type { Project } from "../project";
  import { parseRecordingChangeRequest } from "../recording-operations-contract";
  import {
    recordingOperationsSelection,
    type RecordingOperationsService,
    type OperationsSelection,
  } from "./service";
  import { createRecordingOperationsMonitor } from "./monitor";
  import { phaseLabels, errorLabels } from "./labels";
  import RecordingPlanView from "../recording-management/RecordingPlanView.svelte";
  let {
    openOwner,
    project,
    generation,
    service,
    blocked = false,
    conflict,
    onclose,
  }: {
    openOwner: object | null;
    project: Project;
    generation: number;
    service?: RecordingOperationsService;
    blocked?: boolean;
    conflict?: string;
    onclose: () => void;
  } = $props();
  const monitor = createRecordingOperationsMonitor();
  let presentation = $state.raw(monitor.state);
  const off = monitor.subscribe((next) => (presentation = next));
  onDestroy(() => {
    off();
    monitor.dispose();
  });
  let owner = $state.raw<{
    openOwner: object | null;
    project: Project;
    generation: number;
    service?: RecordingOperationsService;
    selection: OperationsSelection;
  }>();
  let applied = $state(""),
    mapping = $state(""),
    retention = $state(""),
    draftError = $state(false);
  $effect(() => {
    const next = { openOwner, project, generation, service };
    untrack(() => {
      const selection = next.openOwner
        ? recordingOperationsSelection(
            next.service,
            next.project,
            next.generation,
            next.openOwner,
          )
        : ({ phase: "offline" } as const);
      owner = { ...next, selection };
      applied = "";
      mapping = "";
      retention = "";
      draftError = false;
      monitor.select(selection);
    });
  });
  const current = $derived(
    !!openOwner &&
      owner?.openOwner === openOwner &&
      owner.project === project &&
      owner.generation === generation &&
      owner.service === service,
  );
  const binding = $derived(
    current && owner?.selection.phase === "ready"
      ? owner.selection.binding
      : undefined,
  );
  const visible = $derived(current ? presentation : undefined);
  function revision(text: string): number | null {
    if (text === "") return null;
    if (!/^[1-9][0-9]*$/.test(text)) throw Error("invalid");
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw Error("invalid");
    return value;
  }
  function preflight() {
    if (
      blocked ||
      !current ||
      !binding ||
      !visible?.canPreflight ||
      !binding.desired
    )
      return;
    try {
      // getRandomValues is available in HTTP contexts too. IDs are not authority.
      const token = Array.from(
        crypto.getRandomValues(new Uint8Array(16)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const request = parseRecordingChangeRequest({
        version: 1,
        kind: "recordingChangeRequest",
        changeId: `change:${token}`,
        context: binding.context,
        apply: {
          requestId: `apply:${token}`,
          desired: binding.desired,
          expectedAppliedRevision: revision(applied),
          expectedMappingRevision: binding.desired.enabled
            ? revision(mapping)
            : null,
          expectedRetentionAppliedRevision: binding.desired.enabled
            ? revision(retention)
            : null,
        },
      });
      draftError = false;
      monitor.preflight(binding, request, 10000);
    } catch {
      draftError = true;
    }
  }
  function close() {
    owner = undefined;
    monitor.select({ phase: "offline" });
    onclose();
  }
</script>

<Modal
  open={!!openOwner}
  title="記録計画の操作"
  width="1000px"
  onclose={close}
  focusFallback={() =>
    document.querySelector<HTMLButtonElement>("[data-permanent-menu]")}
>
  <div
    class="operations"
    data-recording-operations-phase={visible?.phase ?? "checking"}
  >
    {#if conflict}<p role="alert">{conflict}</p>{/if}
    <p role="status">
      {!visible
        ? "対象を確認中です"
        : !service
          ? "記録操作サービスは未接続です"
          : owner?.selection.phase === "invalidContext"
            ? "接続元の対象情報を確認できません"
            : owner?.selection.phase === "contextMismatch"
              ? "接続元の対象情報が現在のProjectと一致しません"
              : phaseLabels[visible.phase]}
    </p>
    {#if visible?.timedOut}<p role="status">
        期限超過・結果待ち。操作は自動取消されません。
      </p>{/if}
    {#if visible?.oldOwner}<p role="status">
        以前の対象の操作を監視しています。現在のProjectへの送信は停止しています。
      </p>{/if}
    {#if visible?.invalid}<p role="alert">
        応答の整合性を確認できません。接続元での確認が必要です。
      </p>{/if}
    {#if visible?.refusal}<p role="status">
        要求は未送信です: {errorLabels[visible.refusal]}
      </p>{/if}
    {#if visible?.cancel}<p role="status">
        取消要求: {visible.cancel === "requested"
          ? "送信済み（結果待ち）"
          : visible.cancel === "alreadyCompleted"
            ? "既に完了"
            : "この段階では非対応"}
      </p>{/if}
    <p>
      検査・元runの停止とjoin・同候補の適用は、それぞれボタンで実行します。適用後の記録再開は行いません。
    </p>
    {#if visible?.binding}
      {@const c = visible.binding.context}
      <section aria-label="操作元">
        <h3>操作元</h3>
        <p>Project: {c.target.projectId} / {c.target.projectRevision}</p>
        <p>deployment: {c.target.deploymentId} · store: {c.target.storeId}</p>
        <p>元run: {c.recordingRunRef} · session: {c.sessionId}</p>
      </section>
    {/if}
    <section aria-label="Projectの希望設定">
      <h3>Projectの希望設定</h3>
      {#if project.recordingPlan}<RecordingPlanView
          plan={project.recordingPlan}
        />{:else}<p>希望設定なし（停止命令ではありません）</p>{/if}
    </section>
    <section aria-label="新しい変更の期待版">
      <h3>新しい変更の期待版</h3>
      <p>
        記録管理状態で確認した版を入力してください。空欄は「版なし」を意味します。
      </p>
      <label
        >適用版<input
          aria-label="期待適用版"
          inputmode="numeric"
          bind:value={applied}
          disabled={blocked || !visible?.canPreflight}
        /></label
      >
      <label
        >mapping版<input
          aria-label="期待mapping版"
          inputmode="numeric"
          bind:value={mapping}
          disabled={blocked ||
            !visible?.canPreflight ||
            !binding?.desired?.enabled}
        /></label
      >
      <label
        >保持適用版<input
          aria-label="期待保持適用版"
          inputmode="numeric"
          bind:value={retention}
          disabled={blocked ||
            !visible?.canPreflight ||
            !binding?.desired?.enabled}
        /></label
      >
      {#if draftError}<p role="alert">
          期待版を確認してください。有効な希望設定にはmapping版・保持適用版が必要です。
        </p>{/if}
      <button
        type="button"
        disabled={blocked || !binding || !visible?.canPreflight}
        onclick={preflight}>新しい変更を検査</button
      >
    </section>
    {#if visible?.previous?.latest}
      {@const previous = visible.previous.latest}
      <section aria-label="以前の対象の完了結果">
        <h3>以前の対象の完了結果</h3>
        <p>
          Project: {previous.request.change.context.target.projectId} · 元要求ID:
          {previous.request.change.apply.requestId}
        </p>
        <p>
          結果: {previous.outcome.kind === "applied"
            ? "適用commit確認済み"
            : previous.outcome.kind === "failed"
              ? errorLabels[previous.outcome.error]
              : "以前の適用済み要求"}
        </p>
      </section>
    {/if}
    <div class="actions">
      <button
        type="button"
        disabled={blocked || !visible?.canDiscardOriginal}
        onclick={() => {
          if (current && !blocked) monitor.discardOriginal();
        }}>以前の候補を破棄</button
      >
      <button
        type="button"
        disabled={blocked || !binding || !visible?.canPause}
        onclick={() => {
          if (current && !blocked && binding) monitor.pauseJoin(binding, 10000);
        }}>この元runを停止してjoin</button
      >
      <button
        type="button"
        disabled={blocked || !binding || !visible?.canApply}
        onclick={() => {
          if (current && !blocked && binding) monitor.apply(binding, 10000);
        }}>同候補を適用</button
      >
      <button
        type="button"
        disabled={blocked || !binding || !visible?.canDiscard}
        onclick={() => {
          if (current && !blocked && binding) monitor.discard(binding);
        }}>変更候補を破棄</button
      >
      <button
        type="button"
        disabled={blocked || !visible?.canReconcile}
        onclick={() => {
          if (current && !blocked) monitor.reconcile(10000);
        }}>元要求の結果を照会</button
      >
      <button
        type="button"
        disabled={blocked || !visible?.canCancel}
        onclick={() => {
          if (current && !blocked) monitor.requestCancel();
        }}>操作の取消を要求</button
      >
      <button
        type="button"
        disabled={blocked || !visible?.canCancelRead}
        onclick={() => {
          if (current && !blocked) monitor.requestCancel(true);
        }}>照会の取消を要求</button
      >
      <button
        type="button"
        disabled={blocked || !visible?.canSwitch}
        onclick={() => {
          if (current && !blocked) monitor.switchToSelected();
        }}>現在の対象を確認</button
      >
    </div>
    {#if visible?.view?.request}
      <section aria-label="受理済みの変更">
        <h3>受理済みの変更</h3>
        <p>
          変更ID: {visible.view.request.changeId} · 要求ID: {visible.view
            .request.apply.requestId}
        </p>
        <RecordingPlanView plan={visible.view.request.apply.desired} />
      </section>
    {/if}
    {#if visible?.latest}
      {@const r = visible.latest}
      <section aria-label="操作結果">
        <h3>操作結果</h3>
        <p>
          静止確認: {r.quiescence === "confirmed" ? "確認済み" : "不明"} · 回復確認:
          {r.recoveryRequired ? "必要" : "不要"}
        </p>
        {#if r.outcome.kind === "applied"}<p>
            適用commit確認済み: {r.outcome.receipt.commitVersion} · 適用版: {r
              .outcome.receipt.appliedRevision}
          </p>
        {:else if r.outcome.kind === "replay"}<p>
            以前の適用済み要求です。新しい停止・適用は実行していません。
          </p>
        {:else if r.outcome.kind === "failed"}<p>
            結果: {errorLabels[r.outcome.error]} · {r.outcome.effect ===
            "unconfirmed"
              ? "commit有無不明"
              : r.outcome.effect === "notDispatched"
                ? "未送信"
                : "commitなし"}
          </p>{/if}
      </section>
    {/if}
    {#if visible?.lastApplied}<section aria-label="最後に確認した適用">
        <h3>最後に確認した適用（元要求）</h3>
        <p>
          Project: {visible.lastApplied.request.change.context.target.projectId} ·
          要求ID: {visible.lastApplied.request.change.apply.requestId}
        </p>
        <p>
          commit: {visible.lastApplied.receipt.commitVersion} · 適用版: {visible
            .lastApplied.receipt.appliedRevision}
        </p>
      </section>{/if}
  </div>
</Modal>

<style>
  .operations {
    max-height: 75vh;
    overflow: auto;
    display: grid;
    gap: 0.75rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  section {
    border: 1px solid var(--banto-border);
    border-radius: 0.4rem;
    padding: 0.8rem;
    overflow-wrap: anywhere;
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
  }
  p {
    margin: 0.4rem 0;
    white-space: pre-wrap;
  }
  button {
    padding: 0.4rem 0.75rem;
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.4rem;
  }
  input {
    width: 8rem;
  }
</style>
