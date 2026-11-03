<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Modal } from "@banto/ui";
  import type { Project } from "../project";
  import {
    recordingManagementSelection,
    type RecordingManagementService,
    type RecordingManagementSelection,
  } from "./service";
  import {
    createRecordingManagementController,
    type RecordingManagementState,
  } from "./controller";
  import {
    inspectionPhaseLabels,
    comparisonLabel,
    hostPhaseLabels,
    hostIssueLabels,
    inspectionErrorLabels,
    knownFlag,
  } from "./labels";
  import RecordingPlanView from "./RecordingPlanView.svelte";
  let {
    openOwner,
    project,
    generation,
    service,
    onclose,
  }: {
    openOwner: object | null;
    project: Project;
    generation: number;
    service?: RecordingManagementService;
    onclose: () => void;
  } = $props();
  // Remains mounted across Modal close/reopen and all Project/service changes.
  const controller = createRecordingManagementController();
  let presentation = $state.raw<RecordingManagementState>(controller.state);
  const unsubscribe = controller.subscribe((next) => (presentation = next));
  onDestroy(() => {
    unsubscribe();
    controller.dispose();
  });
  let owner = $state.raw<{
    openOwner: object | null;
    project: Project;
    generation: number;
    service?: RecordingManagementService;
    selection: RecordingManagementSelection;
  }>();
  $effect(() => {
    const next = { openOwner, project, generation, service };
    untrack(() => {
      const selection = next.openOwner
        ? recordingManagementSelection(
            next.service,
            next.project,
            next.generation,
            next.openOwner,
          )
        : ({ phase: "offline" } as const);
      owner = { ...next, selection };
      controller.setOwner(selection);
    });
  });
  // Immediate render/action qualification precedes effect retirement.
  const current = $derived(
    !!openOwner &&
      owner?.openOwner === openOwner &&
      owner.project === project &&
      owner.generation === generation &&
      owner.service === service,
  );
  const selection = $derived(current ? owner?.selection : undefined);
  const binding = $derived(
    selection?.phase === "idle" ? selection.owner : undefined,
  );
  const visible = $derived(current ? presentation : undefined);
  const response = $derived(
    visible?.phase === "ready" && visible.owner === binding
      ? visible.response
      : undefined,
  );
  function load() {
    if (current && binding) controller.load(10000);
  }
  function close() {
    owner = undefined;
    controller.setOwner({ phase: "offline" });
    onclose();
  }
</script>

<Modal
  open={!!openOwner}
  title="記録管理状態"
  width="1000px"
  onclose={close}
  focusFallback={() =>
    document.querySelector<HTMLButtonElement>("[data-permanent-menu]")}
>
  <div
    class="recording-management"
    data-recording-management-phase={visible?.phase ?? "checking"}
  >
    <p role="status">
      {visible
        ? inspectionPhaseLabels[visible.phase]
        : "対象を確認中です"}{visible?.phase === "loading" && visible.waiting
        ? "（前の照会の終了待ち）"
        : ""}
    </p>
    <div class="actions">
      <button type="button" disabled={!binding} onclick={load}
        >状態を照会</button
      ><button
        type="button"
        disabled={visible?.phase !== "loading"}
        onclick={() => {
          if (current) controller.cancel(visible?.token);
        }}>照会を取消</button
      >
    </div>
    <p>
      画面を開くだけでは照会しません。設定の適用・記録の開始や停止は行いません。
    </p>
    {#if binding}
      <section aria-label="照会対象">
        <h3>照会対象</h3>
        <p>
          deployment: {binding.context.deploymentId} · store: {binding.context
            .storeId}
        </p>
        <p>履歴namespace: {binding.context.historianNamespace ?? "未提供"}</p>
      </section>
    {/if}
    <section aria-label="Projectの希望設定">
      <h3>Projectの希望設定</h3>
      {#if project.recordingPlan}<RecordingPlanView
          plan={project.recordingPlan}
        />{:else}<p>希望設定なし（停止命令ではありません）</p>{/if}
    </section>
    {#if response}
      {@const db = response.database}
      <section aria-label="希望設定とDBの比較">
        <h3>希望設定とDBの比較</h3>
        <p data-comparison={visible?.comparison?.kind}>
          {visible?.comparison
            ? comparisonLabel(visible.comparison)
            : "比較不能"}
        </p>
      </section>
      <section aria-label="DBの適用状態">
        <h3>DBの適用状態</h3>
        {#if db.state === "unavailable"}<p role="status">
            DB照会失敗 / 部分観測: {inspectionErrorLabels[db.error]}
          </p>
        {:else}
          <dl>
            <dt>snapshot commit</dt>
            <dd>{db.snapshotCommit}</dd>
            <dt>現在のmapping版 / 保持適用版</dt>
            <dd>
              {db.currentMappingRevision ?? "なし"} / {db.currentRetentionAppliedRevision ??
                "なし"}
            </dd>
            <dt>DB active session</dt>
            <dd>{db.activeSessionId ?? "なし"}</dd>
          </dl>
          {#if db.applied}<p>
              適用版 {db.applied.appliedRevision} · commit {db.applied
                .commitVersion}
            </p>
            <p>
              束縛mapping版 / 保持適用版: {db.applied.mappingRevision ?? "なし"} /
              {db.applied.retentionAppliedRevision ?? "なし"}
            </p>
            <RecordingPlanView plan={db.applied.desired} />{:else}<p>
              DB適用設定なし
            </p>{/if}
        {/if}
      </section>
      <section aria-label="最新activation">
        <h3>最新activation</h3>
        {#if db.state === "unavailable"}<p>
            DB状態を取得できません
          </p>{:else if db.latestActivation}
          {@const activation = db.latestActivation}
          <dl>
            <dt>activation ID</dt>
            <dd>{activation.activationId}</dd>
            <dt>状態</dt>
            <dd>
              {activation.state === "active"
                ? "DB active"
                : activation.state === "closed"
                  ? "終了"
                  : "中断"}
            </dd>
            <dt>適用版 / session</dt>
            <dd>{activation.appliedRevision} / {activation.sessionId}</dd>
            <dt>開始 / 終了commit</dt>
            <dd>
              {activation.commitVersion} / {activation.endCommitVersion ??
                "未終了"}
            </dd>
            <dt>記録済みsequence</dt>
            <dd>{activation.committedThrough}</dd>
          </dl>
        {:else}<p>activationなし</p>{/if}
      </section>
      <section aria-label="Hostの別時点観測">
        <h3>Hostの別時点観測</h3>
        {#if response.host.state === "unknown"}<p>
            Host状態は未提供です
          </p>{:else}
          {@const host = response.host}
          <dl>
            <dt>観測UTC（ms）</dt>
            <dd>{host.observedAtMs ?? "未提供"}</dd>
            <dt>phase</dt>
            <dd>{hostPhaseLabels[host.phase]}</dd>
            <dt>Host session / run参照</dt>
            <dd>{host.sessionId ?? "未提供"} / {host.runRef ?? "未提供"}</dd>
            <dt>停止要求</dt>
            <dd>{host.stopRequested ? "あり" : "なし"}</dd>
            <dt>報告原因</dt>
            <dd>{hostIssueLabels[host.issue]}</dd>
            <dt>cleanup</dt>
            <dd>{host.cleanup}</dd>
            <dt>source shutdown</dt>
            <dd>{host.sourceShutdown}</dd>
          </dl>
        {/if}
      </section>
      <section aria-label="保持と回復の状態">
        <h3>保持と回復の状態</h3>
        {#if db.state === "available"}<p>
            DB active保持job: {db.activeRetentionJobId ?? "なし"}
          </p>
          <p>
            保持fence UTC（ms）: {db.retentionFence.cutoffMs ?? "なし"} · commit {db
              .retentionFence.commitVersion}
          </p>{:else}<p>DBの保持状態は取得不能です</p>{/if}
        {#if response.host.state === "observed"}<dl>
            <dt>計画回復</dt>
            <dd>{knownFlag(response.host.planRecoveryRequired)}</dd>
            <dt>保持rearm</dt>
            <dd>{knownFlag(response.host.retentionRearmRequired)}</dd>
            <dt>保持job待機</dt>
            <dd>{knownFlag(response.host.retentionJobPending)}</dd>
          </dl>{:else}<p>Hostの回復・保持gateは未提供です</p>{/if}
      </section>
      <section aria-label="SDKの独立観測">
        <h3>SDKの独立観測</h3>
        {#if response.sdk.state === "unknown"}<p>
            SDK接続状態は未提供です
          </p>{:else}<p>
            観測UTC（ms）: {response.sdk.observedAtMs ?? "未提供"} · 接続: {response
              .sdk.connection}
          </p>{/if}
        <p>Hostの稼働・DB active・SDK接続は別の状態です。</p>
      </section>
    {/if}
  </div>
</Modal>

<style>
  .recording-management {
    max-height: 75vh;
    overflow: auto;
    display: grid;
    gap: 0.75rem;
  }
  .actions {
    display: flex;
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
  dl {
    display: grid;
    grid-template-columns: minmax(11rem, auto) 1fr;
    gap: 0.35rem 1rem;
  }
  dd {
    margin: 0;
    white-space: pre-wrap;
  }
  button {
    padding: 0.4rem 0.75rem;
  }
</style>
