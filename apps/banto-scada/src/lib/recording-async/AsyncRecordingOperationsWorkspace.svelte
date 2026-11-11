<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Modal } from "@banto/ui";
  import type { Project } from "../project";
  import type { AsyncOperationsClient } from "./state";
  import { createAsyncOperationsMonitor } from "./monitor";
  import { parseRecordingChangeRequest } from "../recording-operations-contract";
  import { sameOwnedJson } from "../json-equality";
  import { errorLabels } from "../recording-operations/labels";
  import type { RecordingWireError } from "../recording-wire-contract";
  import RecordingPlanView from "../recording-management/RecordingPlanView.svelte";
  const wireErrorLabels: Record<RecordingWireError, string> = {
    unauthorized: "記録操作には認証が必要です",
    forbidden: "記録操作の権限がありません",
    ownerUnavailable: "記録操作の対象を利用できません",
    expired: "操作の期限が切れました",
    capacity:
      "記録操作の上限に達しました。解消しない場合は記録を停止して再開してください（画面の再読込では回復しません）",
    protocolViolation: "記録操作の要求が受け付けられませんでした",
    internal: "記録操作の内部エラーです",
  };
  let {
    openOwner,
    project,
    generation,
    client,
    blocked = false,
    conflict,
    onclose,
  }: {
    openOwner: object | null;
    project: Project;
    generation: number;
    client?: AsyncOperationsClient;
    blocked?: boolean;
    conflict?: string;
    onclose: () => void;
  } = $props();
  const monitor = createAsyncOperationsMonitor();
  let presentation = $state.raw(monitor.current());
  const off = monitor.subscribe((s) => (presentation = s));
  onDestroy(() => {
    off();
    monitor.dispose();
  });
  let owner = $state.raw<{
    openOwner: object | null;
    project: Project;
    generation: number;
    client?: AsyncOperationsClient;
    blocked: boolean;
  }>();
  let applied = $state(""),
    mapping = $state(""),
    retention = $state(""),
    draftError = $state(false);
  $effect(() => {
    const next = { openOwner, project, generation, client, blocked };
    untrack(() => {
      owner = next;
      applied = "";
      mapping = "";
      retention = "";
      draftError = false;
      monitor.select({
        ...next,
        // Read live props at each send, including before Svelte flushes effects.
        qualifies: () =>
          openOwner === next.openOwner &&
          project === next.project &&
          generation === next.generation &&
          client === next.client &&
          blocked === next.blocked &&
          !blocked,
      });
    });
  });
  const current = $derived(
    !!openOwner &&
      owner?.openOwner === openOwner &&
      owner.project === project &&
      owner.generation === generation &&
      owner.client === client &&
      owner.blocked === blocked,
  );
  const visible = $derived(current ? presentation : undefined);
  const s = $derived(visible?.state);
  const enabled = $derived(current && !blocked);
  const control = () => ({
    intentDeadlineMonotonicMs: performance.now() + 10000,
    requestedNativeBudgetMs: 10000,
  });
  function revision(v: string): number | null {
    if (v === "") return null;
    if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v)))
      throw Error("invalid");
    return Number(v);
  }
  const reservedDiffers = $derived(
    !!s?.reservedChange &&
      (!visible?.desired ||
        !sameOwnedJson(s.reservedChange.apply.desired, visible.desired)),
  );
  function preflight() {
    if (!enabled || !visible?.canPreflight || !visible.desired || !s) return;
    // The registry holds this reservation: only the same change continues it.
    if (s.reservedChange) {
      if (!reservedDiffers) monitor.preflight(s.reservedChange, control());
      return;
    }
    try {
      const token = Array.from(
        crypto.getRandomValues(new Uint8Array(16)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      const change = parseRecordingChangeRequest({
        version: 1,
        kind: "recordingChangeRequest",
        changeId: `change:${token}`,
        context: s.context,
        apply: {
          requestId: `apply:${token}`,
          desired: visible.desired,
          expectedAppliedRevision: revision(applied),
          expectedMappingRevision: visible.desired.enabled
            ? revision(mapping)
            : null,
          expectedRetentionAppliedRevision: visible.desired.enabled
            ? revision(retention)
            : null,
        },
      });
      draftError = false;
      monitor.preflight(change, control());
    } catch {
      draftError = true;
    }
  }
  function close() {
    owner = undefined;
    monitor.select({
      openOwner: null,
      project,
      generation,
      client,
      blocked: true,
    });
    onclose();
  }
  const admissionLabels = {
    idle: "未操作です",
    preparingLease: "受付準備中です",
    awaitingAck: "native受付待ちです",
    unknown: "受付不明です。再送せず受付を照会してください",
    accepted: "受付を確認しました（実処理の完了とは別です）",
    rejected: "接続元が受付を拒否しました",
    discarded: "変更候補の破棄を確認しました",
  };
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
    data-recording-async-admission={s?.admission ?? "offline"}
  >
    {#if conflict}<p role="alert">{conflict}</p>{/if}
    <p role="status">
      {!visible
        ? "対象を確認中です"
        : visible.connection === "offline"
          ? "記録操作サービスは未接続です"
          : visible.connection === "invalidContext"
            ? "接続元の対象情報を確認できません"
            : visible.connection === "contextMismatch"
              ? "接続元の対象情報が現在のProjectと一致しません"
              : s
                ? admissionLabels[s.admission]
                : "対象を確認中です"}
    </p>
    {#if s?.reply?.outcome.kind === "accepted" && s.reply.outcome.handle.kind === "operation" && !s.completion}
      <p role="status">
        {s.reply.outcome.handle.request.stage === "pauseJoin"
          ? "元runの停止・join中です"
          : s.reply.outcome.handle.request.stage === "apply"
            ? "同じ変更候補の設定適用中です"
            : "変更候補の検査結果を待っています"}
      </p>
    {/if}
    {#if s && !s.connected}<p role="status">
        接続切断。発行済み操作の停止や未受理は確認できません。
      </p>{/if}
    {#if s?.owner.ownerClosed}<p role="status">
        記録操作の対象（owner）が終了しました。新しい操作はできません。
      </p>{/if}
    {#if s?.owner.authorizationLost}<p role="status">
        記録操作の権限を確認できません。新しい操作はできません。
      </p>{/if}
    {#if s?.owner.resyncRequired}<p role="status">
        記録操作の状態を再同期しています。新しい操作はできません。
      </p>{/if}
    {#if s?.earlierWork}<p role="status">
        前の画面の作業が残っています。アプリを終了すると候補は破棄されます。
      </p>{/if}
    {#if s?.resumed && s.change && !s.earlierWork}<p role="status">
        前の画面の作業を引き継ぎました。
      </p>{/if}
    {#if s?.reservedChange}<p role="status">
        {reservedDiffers
          ? "前の画面で予約した変更と計画が違うため続けられません。アプリを終了すると予約は解除されます。"
          : "前の画面で予約した変更があります。検査すると同じ変更で続けます。"}
      </p>{/if}
    {#if s?.closed}<p role="status">
        操作元は新しい操作の受付を終了しています。
      </p>{/if}
    {#if visible?.oldOwner}<p role="status">
        以前の対象の操作を監視しています。現在のProjectへの送信は停止しています。
      </p>{/if}
    {#if s?.timedOut}<p role="status">
        期限超過・結果待ち。操作は自動取消されません。
      </p>{/if}
    {#if s?.invalid}<p role="alert">
        応答の整合性または呼出の正常終了を確認できません。接続元での確認が必要です。
      </p>{/if}
    {#if s?.ownerBlocked}<p role="status">
        回復確認が必要です。新しい変更・再適用はできません。
      </p>{/if}
    {#if s?.read === "readUncertain"}<p role="alert">
        読取完了未確認。追加照会と新しい変更はできません。
      </p>{:else if s?.read === "deliveryUnknown"}<p role="alert">
        照会結果の配送を確認できません。読取処理の完了は不明です。
      </p>{:else if s?.read === "awaitingAdmission" || s?.read === "accepted"}<p
        role="status"
      >
        元要求の結果照会中です。
      </p>{/if}
    {#if s?.inspection}<p role="status">
        受付照会: {s.inspection.outcome.kind === "notFound"
          ? "現在は見つかりません。未受理の証明ではありません"
          : s.inspection.outcome.kind === "unavailable"
            ? "照会できません。受付不明を保持します"
            : "元要求の受付情報を確認しました"}
      </p>{/if}
    {#if s?.hostRefusal && s.admission === "idle"}<p role="status">
        {s.hostRefusal.kind === "busy"
          ? "変更を受け付けられませんでした。別の変更が処理中か、この記録の変更がすでに終わっています。新しい変更を始めるには、記録を停止して再開してください"
          : s.hostRefusal.kind === "capacity"
            ? wireErrorLabels.capacity
            : "記録操作が拒否されました"}
      </p>{/if}
    {#if s?.wireRefusal}<p role="status">
        {wireErrorLabels[s.wireRefusal]}
      </p>{/if}
    {#if s?.refusal}<p role="status">
        {s.refusal === "capacity"
          ? "操作IDの上限に達しました。画面を再読込すると操作を続けられます（記録は止まりません）"
          : s.refusal === "unqualified"
            ? "現在の対象へ送信できません"
            : errorLabels[s.refusal]}
      </p>{/if}
    {#if s?.reply && (s.reply.outcome.kind === "rejected" || s.reply.outcome.kind === "unknown")}<p
        role="status"
      >
        受付結果: {errorLabels[s.reply.outcome.error]}
      </p>{/if}
    {#if s?.cancel}<p role="status">
        取消要求: {s.cancel === "requested"
          ? "送信済み（停止完了ではありません）"
          : s.cancel === "alreadyCompleted"
            ? "既に完了"
            : "この段階では非対応"}
      </p>{/if}
    <p>
      検査・元runの停止とjoin・同候補の適用は、それぞれボタンで実行します。適用後の記録再開は行いません。
    </p>
    {#if s}<section aria-label="操作元">
        <h3>操作元</h3>
        <p>
          Project: {s.context.target.projectId} / {s.context.target
            .projectRevision}
        </p>
        <p>
          deployment: {s.context.target.deploymentId} · store: {s.context.target
            .storeId}
        </p>
        <p>
          元run: {s.context.recordingRunRef} · session: {s.context.sessionId}
        </p>
      </section>{/if}
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
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">適用版</span><input
          class="banto-field-control"
          aria-label="期待適用版"
          inputmode="numeric"
          bind:value={applied}
          disabled={!enabled || !visible?.canPreflight}
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">mapping版</span><input
          class="banto-field-control"
          aria-label="期待mapping版"
          inputmode="numeric"
          bind:value={mapping}
          disabled={!enabled ||
            !visible?.canPreflight ||
            !visible.desired?.enabled}
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">保持適用版</span><input
          class="banto-field-control"
          aria-label="期待保持適用版"
          inputmode="numeric"
          bind:value={retention}
          disabled={!enabled ||
            !visible?.canPreflight ||
            !visible.desired?.enabled}
        /></label
      >
      {#if draftError}<p role="alert">
          期待版を確認してください。有効な希望設定にはmapping版・保持適用版が必要です。
        </p>{/if}
      <button
        type="button"
        disabled={!enabled || !visible?.canPreflight}
        onclick={preflight}>新しい変更を検査</button
      >
    </section>
    <div class="actions">
      <button
        type="button"
        disabled={!enabled || !visible?.canPause}
        onclick={() => {
          if (enabled) monitor.pause(control());
        }}>この元runを停止してjoin</button
      >
      <button
        type="button"
        disabled={!enabled || !visible?.canApply}
        onclick={() => {
          if (enabled) monitor.apply(control());
        }}>同候補を適用</button
      >
      <button
        type="button"
        disabled={!enabled || !visible?.canDiscard}
        onclick={() => {
          if (enabled) monitor.discard(control());
        }}>変更候補を破棄</button
      >
      <button
        type="button"
        disabled={!enabled || !visible?.canDiscardOriginal}
        onclick={() => {
          if (enabled) monitor.discard(control(), true);
        }}>以前の候補を破棄</button
      >
      <button
        type="button"
        disabled={!enabled || !visible?.canInspect}
        onclick={() => {
          if (enabled) monitor.inspect(performance.now() + 10000);
        }}>元要求の受付を照会</button
      >
      <button
        type="button"
        disabled={!enabled || !visible?.canReconcile}
        onclick={() => {
          if (enabled) monitor.reconcile(control());
        }}>元要求の結果を照会</button
      >
      <button
        type="button"
        disabled={!enabled || !visible?.canCancel}
        onclick={() => {
          if (enabled) monitor.cancel();
        }}>操作の取消を要求</button
      >
      <button
        type="button"
        disabled={!enabled || !visible?.canCancelRead}
        onclick={() => {
          if (enabled) monitor.cancel(true);
        }}>照会の取消を要求</button
      >
      <button
        type="button"
        disabled={!enabled || !visible?.canSwitch}
        onclick={() => {
          if (enabled) monitor.switchToSelected();
        }}>選択した接続へ切替</button
      >
    </div>
    {#if s?.change}<section aria-label="元要求の変更">
        <h3>元要求の変更</h3>
        <p>変更ID: {s.change.changeId} · 要求ID: {s.change.apply.requestId}</p>
        <RecordingPlanView plan={s.change.apply.desired} />
      </section>{/if}
    {#if s?.latest}{@const r = s.latest}
      <section aria-label="操作結果">
        <h3>操作結果</h3>
        <p>
          静止確認: {r.quiescence === "confirmed" ? "確認済み" : "不明"} · 回復確認:
          {r.recoveryRequired ? "必要" : "不要"}
        </p>
        {#if r.outcome.kind === "candidate"}<p>
            検査済み・元runは停止していません
          </p>{:else if r.outcome.kind === "paused"}<p>
            元runの停止・joinを確認しました
          </p>{:else if r.outcome.kind === "applied"}<p>
            設定commit済み: {r.outcome.receipt.commitVersion} · 適用版: {r
              .outcome.receipt.appliedRevision}。再開は別操作です。
          </p>{:else if r.outcome.kind === "replay"}<p>
            以前の適用済み要求です。新しい停止・適用は実行していません。
          </p>{:else}<p>
            結果: {errorLabels[r.outcome.error]} · {r.outcome.effect ===
            "unconfirmed"
              ? "commit有無不明"
              : r.outcome.effect === "notDispatched"
                ? "未送信"
                : "commitなし"}
          </p>{/if}
      </section>{/if}
    {#if s?.lastApplied}<section aria-label="最後に確認した適用">
        <h3>最後に確認した適用（元要求）</h3>
        <p>
          Project: {s.lastApplied.request.change.context.target.projectId} · 要求ID:
          {s.lastApplied.request.change.apply.requestId}
        </p>
        <p>
          commit: {s.lastApplied.receipt.commitVersion} · 適用版: {s.lastApplied
            .receipt.appliedRevision}
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
