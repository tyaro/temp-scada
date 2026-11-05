<script lang="ts">
  import { Modal } from "@banto/ui";
  import { untrack } from "svelte";
  import type { Project } from "../project";
  import type { DesiredRecordingPlan } from "../recording-plan";
  import { newId } from "../editor";
  import {
    recordingPlanDraft,
    recordingPlanFromDraft,
    validateRecordingPlanEdit,
    type RecordingPlanDraft,
  } from "../recording-plan-edit";
  let {
    open,
    project,
    error = "",
    onsave,
    onremove,
    onclose,
  }: {
    open: boolean;
    project: Project;
    error?: string;
    onsave: (plan: DesiredRecordingPlan) => void;
    onremove: () => void;
    onclose: () => void;
  } = $props();
  const owner = untrack(() => project);
  const saved = owner.recordingPlan;
  const initial: RecordingPlanDraft = saved
    ? recordingPlanDraft(saved)
    : {
        planId: newId(),
        revision: "1",
        enabled: false,
        groupId: newId(),
        hubRef: "",
        periodMs: "1000",
        members: [{ memberId: newId(), externalName: "", valueType: "number" }],
      };
  let draft = $state<RecordingPlanDraft>(structuredClone(initial));
  const baseline = JSON.stringify(initial);
  let localError = $state("");
  const dirty = $derived(JSON.stringify(draft) !== baseline);
  const validation = $derived.by(() => {
    try {
      return {
        plan: validateRecordingPlanEdit(saved, recordingPlanFromDraft(draft)),
        error: "",
      };
    } catch (e) {
      return {
        plan: null,
        error:
          e instanceof Error && e.message !== "Recording plan: invalid"
            ? e.message
            : "ID・タグ外部名・重複・型・周期・版の範囲を確認してください。",
      };
    }
  });
  const canAdvance = $derived(
    saved &&
      saved.planId === draft.planId &&
      saved.revision < Number.MAX_SAFE_INTEGER,
  );
  function move(index: number, delta: number) {
    const rows = [...draft.members],
      to = index + delta;
    if (to < 0 || to >= rows.length) return;
    [rows[index], rows[to]] = [rows[to], rows[index]];
    draft.members = rows;
  }
</script>

<Modal
  {open}
  title="記録希望設定"
  width="900px"
  {dirty}
  onBlockedClose={() =>
    (localError =
      "未保存の入力があります。保存するか「閉じる」で破棄してください。")}
  {onclose}
>
  <p>
    Projectに希望設定だけを保存します。記録の開始・停止・設定適用は行いません。
  </p>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      if (validation.plan) onsave(validation.plan);
    }}
  >
    <div class="fields">
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">計画ID</span><input
          class="banto-field-control"
          bind:value={draft.planId}
          maxlength="64"
          spellcheck="false"
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">希望設定の版</span><input
          class="banto-field-control"
          bind:value={draft.revision}
          inputmode="numeric"
          maxlength="64"
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">グループID</span><input
          class="banto-field-control"
          bind:value={draft.groupId}
          maxlength="64"
          spellcheck="false"
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">論理Hub参照</span><input
          class="banto-field-control"
          bind:value={draft.hubRef}
          maxlength="64"
          spellcheck="false"
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">記録周期（ミリ秒）</span><input
          class="banto-field-control"
          bind:value={draft.periodMs}
          inputmode="numeric"
          maxlength="64"
        /></label
      >
      <label class="check"
        ><input
          type="checkbox"
          bind:checked={draft.enabled}
        />記録を希望する</label
      >
    </div>
    <p>
      周期は100〜3,600,000ミリ秒、系列は1〜8件です。論理Hub参照とタグ外部名は手入力し、接続確認は行いません。
    </p>
    {#if saved}
      <p>
        保存済みの版: {saved.revision}。同じ計画IDで内容を変える場合は新しい版を指定してください。表示順だけの変更は同じ版で保存できます。
      </p>
      <button
        type="button"
        disabled={!canAdvance}
        onclick={() => {
          if (saved.revision < Number.MAX_SAFE_INTEGER)
            draft.revision = String(saved.revision + 1);
        }}>次の版を使う</button
      >
      {#if saved.revision === Number.MAX_SAFE_INTEGER}<p>
          この計画IDでは版の上限に達しています。内容を変えるには別の計画IDを明示してください。
        </p>{/if}
    {/if}
    <div role="group" aria-label="記録する系列">
      {#each draft.members as member, index}
        <fieldset>
          <legend>系列 {index + 1}</legend>
          <div class="fields">
            <label class="banto-field banto-field--stacked"
              ><span class="banto-field-label">メンバーID {index + 1}</span
              ><input
                class="banto-field-control"
                bind:value={member.memberId}
                maxlength="64"
                spellcheck="false"
              /></label
            >
            <label class="banto-field banto-field--stacked"
              ><span class="banto-field-label">値の型 {index + 1}</span><select
                class="banto-field-control"
                aria-label={`値の型 ${index + 1}`}
                bind:value={member.valueType}
                ><option value="number">数値</option><option value="bool"
                  >真偽値</option
                ></select
              ></label
            >
            <label class="external banto-field banto-field--stacked"
              ><span class="banto-field-label">タグ外部名 {index + 1}</span
              ><textarea
                class="banto-field-control"
                rows="2"
                value={member.externalName}
                maxlength="1024"
                spellcheck="false"
                oninput={(e) => (member.externalName = e.currentTarget.value)}
              ></textarea></label
            >
          </div>
          <div class="actions">
            <button
              type="button"
              disabled={index === 0}
              onclick={() => move(index, -1)}>系列{index + 1}を上へ</button
            >
            <button
              type="button"
              disabled={index === draft.members.length - 1}
              onclick={() => move(index, 1)}>系列{index + 1}を下へ</button
            >
            <button
              type="button"
              disabled={draft.members.length === 1}
              onclick={() =>
                (draft.members = draft.members.filter((_, i) => i !== index))}
              >系列{index + 1}を削除</button
            >
          </div>
        </fieldset>
      {/each}
    </div>
    <button
      type="button"
      disabled={draft.members.length >= 8}
      onclick={() =>
        (draft.members = [
          ...draft.members,
          { memberId: newId(), externalName: "", valueType: "number" },
        ])}>系列を追加</button
    >
    {#if validation.error}<p role="status">{validation.error}</p>{/if}
    {#if error || localError}<p role="alert">{error || localError}</p>{/if}
    <p>
      無効設定も系列の内容を残して保存します。Projectから希望設定を除去しても、稼働中の記録は停止しません。
    </p>
    <p>
      版は配布先で予約されません。適用時に競合した場合は、新しい版または別の計画IDを明示して保存してください。
    </p>
    <div class="actions">
      <button type="submit" disabled={!validation.plan}>Projectに保存</button>
      <button
        type="button"
        disabled={!dirty}
        onclick={() => {
          draft = structuredClone(initial);
          localError = "";
        }}>入力を戻す</button
      >
      <button type="button" disabled={!saved || dirty} onclick={onremove}
        >Projectから除去</button
      >
      <button type="button" onclick={onclose}>閉じる</button>
    </div>
  </form>
</Modal>

<style>
  p {
    font-size: 0.85rem;
    color: var(--banto-text-muted);
    margin: 0.75rem 0;
  }
  label {
    display: grid;
    gap: 0.3rem;
  }
  input,
  select,
  textarea {
    min-width: 0;
    width: 100%;
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    padding: 0.4rem;
    border-radius: 4px;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0.75rem 0;
  }
  .check {
    display: flex;
    align-items: center;
  }
  .check input {
    width: auto;
  }
  .external {
    grid-column: 1 / -1;
  }
  fieldset {
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    margin: 0.75rem 0;
    padding: 0.75rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  button {
    font: inherit;
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    color: var(--banto-text);
    background: var(--banto-surface);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  @media (max-width: 600px) {
    .fields {
      grid-template-columns: 1fr;
    }
  }
</style>
