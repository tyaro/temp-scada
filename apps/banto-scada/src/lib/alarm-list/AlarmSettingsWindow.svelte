<script lang="ts">
  import { untrack } from "svelte";
  import { Modal } from "@banto/ui";
  import type { AlarmSnapshot } from "../alarm-mirror";
  import {
    ALARM_SETTINGS_DEFAULTS,
    ALARM_SETTINGS_RANGES,
    alarmRetentionStatusText,
    alarmSettingsForm,
    alarmSettingsReasonText,
    alarmSettingsWarningText,
    alarmSoundFallbackText,
    alarmSoundLabel,
    isAlarmSettingsPermissionRefusal,
    validateAlarmSettingsForm,
    type AlarmSettingsField,
    type AlarmSettingsForm,
    type AlarmSettingsView,
  } from "../alarm-settings";
  import { ProjectFileError, type AlarmFeed } from "../project-file-service";

  /**
   * 警報の端末設定の窓（docs/design/runtime/alarm-terminal-settings.md §7）。
   * 「保存」は保持と読み直しをまとめて保存し、音の操作はその場で host に送る。
   * 範囲は host が正で、画面は同じ規則で先に示す。
   */
  let {
    open,
    feed,
    snapshot,
    onclose,
    onrefresh,
    focusFallback,
  }: {
    open: boolean;
    feed?: AlarmFeed;
    snapshot: AlarmSnapshot | null;
    onclose: () => void;
    /** 変更の後に snapshot を取り直させる（`buzzerSound` を最新にする）。 */
    onrefresh: () => void;
    focusFallback?: () => HTMLElement | null | undefined;
  } = $props();

  let view = $state.raw<AlarmSettingsView | null>(null);
  let loadIssue = $state<string | null>(null);
  let form = $state<AlarmSettingsForm>(
    alarmSettingsForm(ALARM_SETTINGS_DEFAULTS),
  );
  /** 権限が無いなど、変更できない理由。値は読める。 */
  let lockedReason = $state<string | null>(null);
  let busy = $state(false);
  let saveIssue = $state<string | null>(null);
  let saveDone = $state<string | null>(null);
  let soundIssue = $state<string | null>(null);
  let soundDone = $state<string | null>(null);

  const validation = $derived(validateAlarmSettingsForm(form));
  const errors = $derived<Partial<Record<AlarmSettingsField, string>>>(
    validation.ok ? {} : validation.errors,
  );
  const ringing = $derived(!!snapshot?.engine && snapshot.buzzer === "ringing");
  const canChange = $derived(!!view && !lockedReason && !busy);

  function reasonOf(error: unknown): string {
    if (error instanceof ProjectFileError) return error.reason;
    if (error instanceof Error) return error.message;
    return String(error);
  }

  /** 拒否の理由を示す。権限によるものなら以後は読むだけにする。 */
  function refused(error: unknown): string {
    const reason = reasonOf(error);
    const text = alarmSettingsReasonText(reason);
    if (isAlarmSettingsPermissionRefusal(reason)) lockedReason = text;
    return text;
  }

  function show(next: AlarmSettingsView) {
    view = next;
    form = alarmSettingsForm(next);
  }

  /** 種類を切り替えたら、隠れる側の値が範囲外のとき最後に読んだ値へ戻す。
   * host は両方の値を検査するので残す必要があるが、見えない誤りで「保存」を
   * 押せなくしない。 */
  function switchedKind() {
    const hidden = form.kind === "days" ? "count" : "days";
    if (errors[hidden]) {
      form[hidden] = alarmSettingsForm(view ?? ALARM_SETTINGS_DEFAULTS)[hidden];
    }
  }

  /** 開閉のたびに進める。前に開いていたときの操作の結果（成功・失敗・
   * 終わり）は、いまの窓の入力や busy を変えない。host の操作は取り消さない。 */
  let generation = 0;

  async function load() {
    const read = feed?.alarmSettings;
    if (!read) return;
    const current = generation;
    busy = true;
    try {
      const next = await read();
      if (current === generation) show(next);
    } catch (error) {
      if (current === generation) {
        loadIssue = alarmSettingsReasonText(reasonOf(error));
      }
    } finally {
      if (current === generation) busy = false;
    }
  }

  // 開くたびに前の結果を捨てて読み直す。閉じたら前の操作の結果を捨てる。
  $effect(() => {
    if (!open) {
      generation += 1;
      return;
    }
    untrack(() => {
      generation += 1;
      busy = false;
      view = null;
      loadIssue = null;
      saveIssue = saveDone = soundIssue = soundDone = null;
      lockedReason =
        feed?.setAlarmSettings && feed.importAlarmSound && feed.resetAlarmSound
          ? null
          : "この版では端末設定を変更できません。";
      void load();
    });
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const write = feed?.setAlarmSettings;
    if (!write || !validation.ok || !canChange) return;
    const current = generation;
    busy = true;
    saveIssue = saveDone = null;
    try {
      const next = await write(validation.settings);
      if (current === generation) {
        show(next);
        saveDone =
          "保存しました。読み直しの値はすぐに使われ、保持の上限は次の整理から使われます。";
      }
    } catch (error) {
      if (current === generation) saveIssue = refused(error);
    } finally {
      if (current === generation) busy = false;
      onrefresh();
    }
  }

  async function soundAction(
    action: "import" | "reset" | "test",
  ): Promise<void> {
    if (!feed) return;
    const current = generation;
    busy = true;
    soundIssue = soundDone = null;
    try {
      if (action === "test") {
        await feed.testAlarmSound?.();
        if (current === generation) {
          soundDone = "いまの設定の音を一度鳴らしました。";
        }
      } else {
        const next =
          action === "import"
            ? await feed.importAlarmSound?.()
            : await feed.resetAlarmSound?.();
        if (next && current === generation) {
          // 音の変更では保持・読み直しの入力中の値を残す。
          view = next;
          soundDone =
            action === "import"
              ? "音を取り込みました。"
              : "既定のビープに戻しました。";
        }
      }
    } catch (error) {
      if (current === generation) soundIssue = refused(error);
    } finally {
      if (current === generation) busy = false;
      if (action !== "test") onrefresh();
    }
  }
</script>

{#snippet field(
  name: AlarmSettingsField,
  label: string,
  unit: string,
  hint: string,
)}
  <label class="banto-field banto-field--stacked"
    ><span class="banto-field-label">{label}（{unit}）</span><input
      class="banto-field-control"
      {name}
      inputmode="numeric"
      bind:value={form[name]}
      disabled={!canChange}
      aria-invalid={!!errors[name]}
      aria-describedby={`alarm-settings-${name}-hint`}
    /><small id={`alarm-settings-${name}-hint`} class:error={!!errors[name]}
      >{errors[name] ?? hint}</small
    ></label
  >
{/snippet}

<Modal {open} title="警報の端末設定" width="640px" {onclose} {focusFallback}>
  <form
    class="alarm-settings"
    aria-label="警報の端末設定"
    data-alarm-settings
    onsubmit={save}
    oninput={() => (saveIssue = saveDone = null)}
  >
    <p class="lead">この端末だけの設定です（Project には保存しません）。</p>
    {#if loadIssue}<p class="notice" role="alert">{loadIssue}</p>{/if}
    {#if lockedReason}
      <p class="notice" role="status" data-alarm-settings-locked>
        {lockedReason} 値は読めますが変更できません。
      </p>
    {/if}
    {#each view?.warnings ?? [] as warning (warning)}
      <p class="notice" role="status" data-alarm-settings-warning>
        {alarmSettingsWarningText(warning)}
      </p>
    {/each}

    <fieldset>
      <legend>履歴の保持</legend>
      <div class="kinds" role="radiogroup" aria-label="保持の上限の種類">
        <label
          ><input
            type="radio"
            name="kind"
            value="days"
            bind:group={form.kind}
            onchange={switchedKind}
            disabled={!canChange}
          /> 日数で残す</label
        >
        <label
          ><input
            type="radio"
            name="kind"
            value="count"
            bind:group={form.kind}
            onchange={switchedKind}
            disabled={!canChange}
          /> 件数で残す</label
        >
      </div>
      <div class="fields">
        {#if form.kind === "days"}
          {@render field(
            "days",
            "保持の日数",
            "日",
            `${ALARM_SETTINGS_RANGES.days[0]}〜${ALARM_SETTINGS_RANGES.days[1].toLocaleString("ja-JP")} 日`,
          )}
        {:else}
          {@render field("count", "保持の件数", "件", "10,000〜10,000,000 件")}
        {/if}
      </div>
      <p role="status" data-alarm-retention-status>
        {view ? alarmRetentionStatusText(view.retentionStatus) : "読込み中…"}
      </p>
      <p class="hint">
        いま続いている警報のイベントは、期限を過ぎても消さずに残します。
      </p>
    </fieldset>

    <fieldset>
      <legend>値の読み直し</legend>
      <div class="fields">
        {@render field("intervalSec", "読み直しの周期", "秒", "2〜300 秒")}
        {@render field("timeoutSec", "1 回の期限", "秒", "1 秒〜周期")}
        {@render field(
          "failureLimitSec",
          "連続失敗の期限",
          "秒",
          "周期の 2 倍〜3,600 秒",
        )}
        {@render field(
          "reconnectFailures",
          "張り直しの連続失敗",
          "回",
          "1〜10 回",
        )}
      </div>
      <p class="hint">
        保存するとすぐに使われます（Engine の再起動は要りません）。
      </p>
    </fieldset>

    <fieldset>
      <legend>ブザーの音</legend>
      <p role="status" data-alarm-sound>
        いまの音: {view ? alarmSoundLabel(view.sound) : "読込み中…"}
      </p>
      {#if view?.soundFallback}
        <p class="notice" role="status" data-alarm-sound-fallback>
          {alarmSoundFallbackText(
            view.soundFallback,
          )}ため、既定のビープで鳴らしています。
        </p>
      {/if}
      <p class="hint">
        WAV（リニア PCM・8 / 16 ビット・モノラルかステレオ・1 MB と 5
        秒まで）を取り込めます。 音の操作は「保存」を待たずにすぐ反映します。
      </p>
      <div class="actions sound">
        <button
          type="button"
          disabled={!canChange}
          onclick={() => soundAction("import")}>ファイルを選ぶ</button
        >
        <button
          type="button"
          disabled={!canChange || view?.sound.kind !== "custom"}
          onclick={() => soundAction("reset")}>既定に戻す</button
        >
        <button
          type="button"
          disabled={!feed?.testAlarmSound || busy || ringing}
          title={ringing
            ? "ブザーが鳴っている間は試しに鳴らせません"
            : undefined}
          onclick={() => soundAction("test")}>試しに鳴らす</button
        >
      </div>
      {#if ringing}
        <p class="hint" data-alarm-sound-ringing>
          ブザーが鳴っている間は試しに鳴らせません。
        </p>
      {/if}
      {#if soundIssue}<p class="notice" role="alert">{soundIssue}</p>{/if}
      {#if soundDone}<p role="status" data-alarm-sound-done>{soundDone}</p>{/if}
    </fieldset>

    {#if saveIssue}<p class="notice" role="alert">{saveIssue}</p>{/if}
    {#if saveDone}<p role="status" data-alarm-settings-saved>{saveDone}</p>{/if}
    <div class="actions">
      <span class="hint"
        >「保存」は履歴の保持と値の読み直しをまとめて保存します。</span
      >
      <button type="submit" disabled={!canChange || !validation.ok}>保存</button
      >
    </div>
  </form>
</Modal>

<style>
  .alarm-settings {
    display: grid;
    gap: 0.75rem;
  }
  p {
    margin: 0;
    line-height: 1.6;
  }
  .lead,
  .hint {
    color: var(--banto-text-muted, inherit);
  }
  fieldset {
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    padding: 0.75rem;
    display: grid;
    gap: 0.6rem;
    margin: 0;
  }
  legend {
    font-weight: 600;
    padding: 0 0.25rem;
  }
  .kinds {
    display: flex;
    gap: 1.25rem;
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.8rem;
  }
  small {
    color: var(--banto-text-muted, inherit);
  }
  small.error,
  [role="alert"] {
    color: var(--banto-danger, #dc2626);
  }
  .notice {
    border-left: 3px solid var(--banto-warning, #d97706);
    padding-left: 0.5rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .actions .hint {
    margin-right: auto;
    align-self: center;
    font-size: 0.85em;
  }
  .actions.sound {
    justify-content: flex-start;
  }
  button {
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    padding: 7px 14px;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  button[type="submit"] {
    background: var(--banto-primary-solid);
    color: var(--banto-on-solid);
  }
  button[type="submit"]:hover:not(:disabled) {
    background: var(--banto-primary-solid-hover);
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
