<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Modal, StatusBadge } from "@banto/ui";
  import type { Project } from "../project";
  import {
    recordingManagementSelection,
    type RecordingManagementService,
    type RecordingSlotView,
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
    controlErrorLabel,
    type RecordingControlAction,
  } from "./labels";
  import RecordingPlanView from "./RecordingPlanView.svelte";
  import {
    inspectedAtLabel,
    recordingSummary,
    type RecordingSummary,
  } from "./summary";
  let {
    openOwner,
    project,
    generation,
    service,
    onclose,
    onsummary,
  }: {
    openOwner: object | null;
    project: Project;
    generation: number;
    service?: RecordingManagementService;
    onclose: () => void;
    /** The last inspection's one-line state, for the header (P0-1). */
    onsummary?: (value: {
      summary: RecordingSummary;
      inspectedAt: number;
    }) => void;
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
  // Each new inspection result, with the local time it arrived: the state is
  // as of that time, so the header shows it next to the badge.
  let inspected = $state.raw<{
    response: NonNullable<typeof response>;
    summary: RecordingSummary;
    at: number;
  }>();
  $effect(() => {
    const next = response;
    if (!next) return;
    untrack(() => {
      if (inspected?.response === next) return;
      inspected = {
        response: next,
        summary: recordingSummary(next),
        at: Date.now(),
      };
      onsummary?.({ summary: inspected.summary, inspectedAt: inspected.at });
    });
  });
  const summaryShown = $derived(
    response && inspected?.response === response ? inspected : undefined,
  );
  // The registry slot, read with each inspection when the owner rebind is
  // offered (design §7.2): the Project revision the running recording's
  // operations context names.
  let slot = $state.raw<{ owner: object; view: RecordingSlotView }>();
  const slotShown = $derived(
    slot && slot.owner === binding ? slot.view : undefined,
  );
  async function readSlot() {
    const target = binding;
    const read = target?.service.slot;
    if (!current || !target || !read || !target.service.ownerRebind) return;
    const view = await read();
    if (binding === target) slot = { owner: target, view };
  }
  function load() {
    if (current && binding) {
      controller.load(10000);
      void readSlot();
    }
  }
  // The administrator's control (design §5, §8-5): the first setup while the
  // DB has no applied plan and the Project's plan is enabled; then stopping,
  // applying the Project's plan while stopped, and resuming. The host decides
  // finally; the buttons follow the last inspection. One runs at a time.
  let operation = $state.raw<{
    owner: object;
    action: RecordingControlAction;
    running: boolean;
    message?: string;
    failed?: boolean;
  }>();
  const operationShown = $derived(
    operation?.owner === binding ? operation : undefined,
  );
  const operating = $derived(!!operationShown?.running);
  const database = $derived(
    response?.database.state === "available" ? response.database : undefined,
  );
  const canSetup = $derived(
    !!binding?.service.initialSetup &&
      database?.applied === null &&
      binding.desired?.enabled === true &&
      !operating,
  );
  const canResume = $derived(
    !!binding?.service.resume &&
      database?.applied?.desired.enabled === true &&
      database.activeSessionId === null &&
      !operating,
  );
  const canReconfigure = $derived(
    !!binding?.service.reconfigure &&
      !!database?.applied &&
      database.activeSessionId === null &&
      binding.desired !== undefined &&
      !operating,
  );
  const canStop = $derived(
    !!binding?.service.stop &&
      !!database &&
      database.activeSessionId !== null &&
      !operating,
  );
  const slotBehind = $derived(
    slotShown?.state === "installed" &&
      !!binding &&
      slotShown.projectId === binding.project.manifest.projectId &&
      slotShown.projectRevision !== binding.project.manifest.projectRevision,
  );
  const canRebind = $derived(
    !!binding?.service.ownerRebind && slotBehind && !operating,
  );
  const controlsOffered = $derived(
    !!(
      binding?.service.resume ||
      binding?.service.reconfigure ||
      binding?.service.stop
    ),
  );
  const startedMessage = (phase: "running" | "starting", verb: string) =>
    phase === "running"
      ? `記録を${verb}しました`
      : `記録の${verb}を受け付けました（開始待ち）`;
  async function control<R extends { ok: boolean }>(
    action: RecordingControlAction,
    allowed: boolean,
    pick: (
      service: RecordingManagementService,
    ) => (() => Promise<R>) | undefined,
    message: (result: Extract<R, { ok: true }>) => string,
  ) {
    const target = binding;
    const run = target && pick(target.service);
    if (!current || !target || !run || !allowed) return;
    operation = { owner: target, action, running: true };
    const result = await run();
    if (binding !== target) return;
    operation = result.ok
      ? {
          owner: target,
          action,
          running: false,
          message: message(result as Extract<R, { ok: true }>),
        }
      : {
          owner: target,
          action,
          running: false,
          failed: true,
          message: controlErrorLabel(
            action,
            (result as unknown as { error: string }).error,
          ),
        };
    load();
  }
  const initialSetup = () =>
    control(
      "setup",
      canSetup,
      (s) => s.initialSetup,
      (r) => startedMessage(r.phase, "開始"),
    );
  const resume = () =>
    control(
      "resume",
      canResume,
      (s) => s.resume,
      (r) =>
        startedMessage(r.phase, "再開") +
        (r.owner === "installed"
          ? ""
          : "。記録は続いていますが、記録操作の受付を準備できませんでした（registryの変更は使えません）"),
    );
  const reconfigure = () =>
    control(
      "reconfigure",
      canReconfigure,
      (s) => s.reconfigure,
      (r) =>
        (r.applied === "applied"
          ? "Projectの計画をDBに適用しました"
          : "DBの計画はProjectの計画と同じです（変更なし）") +
        (r.enabled
          ? "。記録は止まったままです。「記録を再開」で開始します"
          : "。計画は無効（enabled: false）なので記録は開始しません"),
    );
  // Stopping makes a gap in the record, so it asks first (UX review P0-1).
  let stopConfirmOpen = $state(false);
  function askStop() {
    if (current && canStop) stopConfirmOpen = true;
  }
  function confirmStop() {
    stopConfirmOpen = false;
    void stop();
  }
  const stop = () =>
    control(
      "stop",
      canStop,
      (s) => s.stop,
      () => "記録を停止しました",
    );
  const rebind = () =>
    control(
      "rebind",
      canRebind,
      (s) => s.ownerRebind,
      (r) =>
        r.owner === "installed"
          ? "記録操作の対象を現在のProjectに合わせました。記録は続いています"
          : "記録は続いていますが、記録操作の受付を準備できませんでした（registryの変更は使えません）",
    );
  const runningLabel: Record<RecordingControlAction, string> = {
    setup: "初回設定中…",
    resume: "再開中…",
    reconfigure: "適用中…",
    stop: "停止中…",
    rebind: "付け替え中…",
  };
  const buttonLabel = (action: RecordingControlAction, idle: string) =>
    operationShown?.running && operationShown.action === action
      ? runningLabel[action]
      : idle;
  function close() {
    stopConfirmOpen = false;
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
    <div
      class="summary"
      data-recording-summary={summaryShown?.summary.state ?? "unread"}
    >
      {#if summaryShown}
        <StatusBadge
          variant={summaryShown.summary.variant}
          label={summaryShown.summary.label}
        />
        <span>{summaryShown.summary.detail}</span>
        <span class="summary-time"
          >照会 {inspectedAtLabel(summaryShown.at)} 時点</span
        >
      {:else}
        <StatusBadge variant="neutral" label="記録状態は未照会" />
      {/if}
    </div>
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
      画面を開くだけでは照会しません。照会では設定の適用・記録の開始や停止は行いません。
    </p>
    {#if binding?.service.initialSetup}
      <section aria-label="初回設定と開始">
        <h3>初回設定と開始</h3>
        <p>
          Projectの希望設定をそのまま使い、Hubのタグとの対応の登録、既定の保持方針（経過30日）の適用、計画の適用を行って記録を開始します。DBに適用済みの設定がない間だけ実行できます。
        </p>
        <div class="actions">
          <button
            type="button"
            disabled={!canSetup}
            data-recording-initial-setup
            onclick={() => void initialSetup()}
            >{buttonLabel("setup", "初回設定と開始")}</button
          >
        </div>
        {#if !response}<p>実行する前に状態を照会してください。</p>{/if}
        {#if operationShown?.action === "setup" && operationShown.message}<p
            role={operationShown.failed ? "alert" : "status"}
            data-recording-setup-result={operationShown.failed
              ? "failed"
              : "ok"}
          >
            {operationShown.message}
          </p>{/if}
      </section>
    {/if}
    {#if controlsOffered}
      <section aria-label="記録の停止と再開">
        <h3>記録の停止と再開</h3>
        {#if binding?.service.stop}<p>
            記録の停止:
            設定を変えずに記録を止めます。記録中の間だけ実行できます。
          </p>{/if}
        {#if binding?.service.reconfigure}<p>
            停止中に計画を適用:
            記録が止まっている間に、Projectの希望設定をDBへ適用します。記録は開始しません。有効な計画なら、続けて「記録を再開」を実行します。
          </p>{/if}
        {#if binding?.service.resume}<p>
            記録を再開:
            DBに適用済みの計画を、Hubのタグを読み直して再開します。記録操作画面での変更の適用後と、アプリの再起動後に使います。
          </p>{/if}
        <div class="actions">
          {#if binding?.service.stop}<button
              type="button"
              disabled={!canStop}
              data-recording-stop
              onclick={askStop}>{buttonLabel("stop", "記録を停止")}</button
            >{/if}
          {#if binding?.service.reconfigure}<button
              type="button"
              disabled={!canReconfigure}
              data-recording-reconfigure
              onclick={() => void reconfigure()}
              >{buttonLabel("reconfigure", "停止中に計画を適用")}</button
            >{/if}
          {#if binding?.service.resume}<button
              type="button"
              disabled={!canResume}
              data-recording-resume
              onclick={() => void resume()}
              >{buttonLabel("resume", "記録を再開")}</button
            >{/if}
        </div>
        {#if !response}<p>実行する前に状態を照会してください。</p>{/if}
        {#if operationShown && operationShown.action !== "setup" && operationShown.action !== "rebind" && operationShown.message}<p
            role={operationShown.failed ? "alert" : "status"}
            data-recording-control-result={operationShown.failed
              ? "failed"
              : "ok"}
            data-recording-control-action={operationShown.action}
          >
            {operationShown.message}
          </p>{/if}
      </section>
    {/if}
    {#if binding?.service.ownerRebind}
      <section aria-label="記録操作の対象">
        <h3>記録操作の対象</h3>
        <p>
          記録操作画面の変更は、記録を始めたときのProjectの版に対して受け付けます。記録中にProjectを編集したら、記録を止めずに対象を現在のProjectへ合わせます。記録操作画面の変更が途中のときはできません。
        </p>
        <p data-recording-slot={slotShown?.state ?? "unread"}>
          {#if !slotShown}未照会{:else if slotShown.state === "installed"}対象のProject版:
            {slotShown.projectRevision}（現在のProject版: {binding.project
              .manifest.projectRevision}）{slotShown.projectId !==
            binding.project.manifest.projectId
              ? "。別のProjectを対象にしています"
              : slotBehind
                ? ""
                : "。現在のProjectと同じです"}{:else if slotShown.state === "empty"}記録操作の受付なし（{slotShown.reason}）{:else}照会できませんでした（{slotShown.error}）{/if}
        </p>
        <div class="actions">
          <button
            type="button"
            disabled={!canRebind}
            data-recording-owner-rebind
            onclick={() => void rebind()}
            >{buttonLabel(
              "rebind",
              "記録操作の対象を現在のProjectに合わせる",
            )}</button
          >
        </div>
        {#if operationShown?.action === "rebind" && operationShown.message}<p
            role={operationShown.failed ? "alert" : "status"}
            data-recording-rebind-result={operationShown.failed
              ? "failed"
              : "ok"}
          >
            {operationShown.message}
          </p>{/if}
      </section>
    {/if}
    {#if response}
      <section aria-label="希望設定とDBの比較">
        <h3>希望設定とDBの比較</h3>
        <p data-comparison={visible?.comparison?.kind}>
          {visible?.comparison
            ? comparisonLabel(visible.comparison)
            : "比較不能"}
        </p>
      </section>
    {/if}
    <details class="diagnostics" data-recording-diagnostics>
      <summary>診断項目（照会対象・希望設定・DB・Host・SDK）</summary>
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
                束縛mapping版 / 保持適用版: {db.applied.mappingRevision ??
                  "なし"} /
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
            {#if activation.state === "interrupted"}<p
                data-recording-interrupted
              >
                前回の記録は終了を確認できないまま中断しました（アプリの異常終了など）。管理者が「記録を再開」で再開できます。
              </p>{/if}
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
              保持fence UTC（ms）: {db.retentionFence.cutoffMs ?? "なし"} · commit
              {db.retentionFence.commitVersion}
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
    </details>
  </div>
</Modal>

<Modal
  open={stopConfirmOpen}
  title="記録を停止しますか"
  width="480px"
  onclose={() => (stopConfirmOpen = false)}
>
  <div class="stop-confirm" data-recording-stop-confirm>
    <p>
      Projectの記録計画による記録を止めます。止めている間の値は記録されず、履歴に欠測が残ります。
    </p>
    <p>
      再開するには、この画面で「状態を照会」してから「記録を再開」を押します。
    </p>
    <div class="actions">
      <button type="button" class="danger" onclick={confirmStop}
        >記録を停止する</button
      >
      <button type="button" onclick={() => (stopConfirmOpen = false)}
        >キャンセル</button
      >
    </div>
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
  .summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--banto-border);
    border-radius: 0.4rem;
  }
  .summary-time {
    color: var(--banto-text-muted);
  }
  .diagnostics {
    display: grid;
    gap: 0.75rem;
  }
  .diagnostics[open] > summary {
    margin-bottom: 0.75rem;
  }
  .diagnostics > summary {
    cursor: pointer;
  }
  .diagnostics > section + section {
    margin-top: 0.75rem;
  }
  .stop-confirm {
    display: grid;
    gap: 0.5rem;
  }
  .stop-confirm .actions {
    justify-content: flex-end;
  }
  button.danger {
    border: 1px solid var(--banto-danger-solid);
    border-radius: 4px;
    background: var(--banto-danger-solid);
    color: #fff;
  }
</style>
