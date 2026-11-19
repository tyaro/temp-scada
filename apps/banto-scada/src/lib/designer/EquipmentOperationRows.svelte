<script lang="ts">
  import { tick } from "svelte";
  import { Modal } from "@banto/ui";
  import type { Project } from "../project";
  import { resolveEquipmentSlot, type EquipmentContext } from "../symbol-slots";
  import {
    buildOperationRequest,
    confirmationContent,
    inputDecimals,
    operationRows,
    parseOperationInput,
    reasonText,
    type ConfirmationContent,
    type OperationChoice,
    type OperationRow,
  } from "../operation";
  import {
    faceplateNotice,
    ipcErrorText,
    operationTimeText,
    rowStatus,
    type OperationHost,
    type OperationPlacement,
    type RowAnswer,
    type ViewState,
  } from "../operation-faceplate";

  /** 標準 Faceplate の操作の行（段階3の運転操作 §8）。Runtime mode だけで出す。 */
  let {
    equipmentId,
    project,
    equipmentContext,
    host,
    placement,
  }: {
    equipmentId: string;
    project: Project;
    equipmentContext: EquipmentContext;
    host: OperationHost;
    placement: OperationPlacement | null;
  } = $props();

  const equipment = $derived(
    project.equipment?.find((item) => item.id === equipmentId),
  );
  const rows = $derived(operationRows(project, equipmentId));
  let viewState = $state<ViewState>({ status: "loading" });
  let sending = $state(false);
  let answers = $state<Record<string, RowAnswer | undefined>>({});
  let inputs = $state<Record<string, string>>({});
  let inputErrors = $state<Record<string, string | undefined>>({});
  let pending = $state<{
    row: OperationRow;
    choice: OperationChoice;
    expectedValue: boolean | number;
    content: ConfirmationContent;
  } | null>(null);
  let cancelButton = $state<HTMLButtonElement>();
  let issued = 0;

  async function refresh() {
    const ticket = ++issued;
    try {
      const view = await host.view(equipmentId);
      if (ticket === issued) viewState = { status: "ready", view };
    } catch (error) {
      if (ticket === issued)
        viewState = { status: "error", message: ipcErrorText(error) };
    }
  }
  $effect(() => {
    equipmentId;
    host;
    viewState = { status: "loading" };
    answers = {};
    inputErrors = {};
    void refresh();
  });

  const notice = $derived(faceplateNotice(viewState, placement, sending, host));
  const latestOf = (slot: string) =>
    viewState.status === "ready"
      ? (viewState.view.slots.find((item) => item.slot === slot)?.latest ??
        null)
      : null;
  const current = (row: OperationRow) =>
    resolveEquipmentSlot(
      equipmentId,
      row.slotName,
      row.slotType,
      equipmentContext,
    );

  async function ask(row: OperationRow, choice: OperationChoice) {
    if (notice.disabled || !equipment) return;
    let expectedValue: boolean | number;
    if ("buttonIndex" in choice) {
      const button = row.buttons[choice.buttonIndex];
      if (!button) return;
      expectedValue = button.value;
    } else {
      const decimals = placement
        ? inputDecimals(
            project,
            placement.screenId,
            placement.objectId,
            row.slotName,
          )
        : null;
      const parsed = parseOperationInput(
        choice.input,
        row.slotType,
        decimals,
        row.input,
      );
      if (!parsed.ok) {
        inputErrors[row.slotName] = reasonText(parsed.reason);
        return;
      }
      inputErrors[row.slotName] = undefined;
      expectedValue = parsed.value;
    }
    pending = {
      row,
      choice,
      expectedValue,
      content: confirmationContent(equipment, row, current(row), choice),
    };
    // Modal は開いたときに先頭（×）へ移す。既定のボタンは「取消」（§8）。
    await tick();
    cancelButton?.focus();
  }

  async function execute() {
    const target = pending;
    if (!target || !placement || sending) return;
    pending = null;
    sending = true;
    const slot = target.row.slotName;
    try {
      const result = await host.write(
        buildOperationRequest({
          projectId: host.projectId,
          projectDigest: host.projectDigest,
          screenId: placement.screenId,
          objectId: placement.objectId,
          equipmentId,
          slotName: slot,
          choice: target.choice,
          expectedValue: target.expectedValue,
        }),
      );
      answers[slot] = { kind: "result", result, atMs: Date.now() };
    } catch (error) {
      answers[slot] = { kind: "error", message: ipcErrorText(error) };
    } finally {
      sending = false;
    }
    await refresh();
  }
</script>

{#if rows.length}
  <section
    class="operation-rows"
    aria-label="機器の操作"
    data-operation-blocked={notice.disabled ? "true" : undefined}
  >
    <h4>操作</h4>
    {#if notice.banner}<p class="banner" role="status" data-operation-banner>
        {notice.banner}
      </p>{/if}
    {#if notice.disabled}<p
        class="disabled"
        role="status"
        data-operation-disabled
      >
        {notice.disabled}
      </p>{/if}
    <ul>
      {#each rows as row (row.slotName)}
        {@const display = current(row)}
        {@const status = rowStatus(
          latestOf(row.slotName),
          answers[row.slotName] ?? null,
        )}
        <li data-operation-slot={row.slotName}>
          <div class="head">
            <strong>{row.label}</strong>
            <span class="value"
              >現在値 {display.text}{#if display.state !== "good"}
                · {display.label}{/if}</span
            >
          </div>
          <div class="controls">
            {#each row.buttons as button (button.index)}
              <button
                type="button"
                disabled={!!notice.disabled}
                onclick={() => ask(row, { buttonIndex: button.index })}
                >{button.label}</button
              >
            {/each}
            {#if row.input}
              <form
                onsubmit={(event) => {
                  event.preventDefault();
                  void ask(row, { input: inputs[row.slotName] ?? "" });
                }}
              >
                <input
                  type="text"
                  inputmode="decimal"
                  aria-label={`${row.label}（${row.input.min}〜${row.input.max}）`}
                  placeholder={`${row.input.min}〜${row.input.max}`}
                  disabled={!!notice.disabled}
                  bind:value={inputs[row.slotName]}
                  aria-invalid={inputErrors[row.slotName] ? "true" : undefined}
                /><button type="submit" disabled={!!notice.disabled}
                  >設定</button
                >
              </form>
            {/if}
          </div>
          {#if inputErrors[row.slotName]}<p class="error" role="alert">
              {inputErrors[row.slotName]}
            </p>{/if}
          {#if status}
            <p class="result" data-operation-result>
              {status.texts.join(" · ")}{#if status.atMs !== null}
                · {operationTimeText(status.atMs)}{/if}{#if status.reason}
                · {status.reason}{/if}
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<Modal
  open={!!pending}
  title="操作の確認"
  onclose={() => (pending = null)}
  focusFallback={() => null}
>
  {#if pending}
    <dl class="confirm">
      <dt>機器</dt>
      <dd>{pending.content.equipmentCode} · {pending.content.equipmentName}</dd>
      <dt>操作</dt>
      <dd>{pending.content.label}</dd>
      <dt>値</dt>
      <dd data-operation-confirm-value>
        {pending.content.currentText} → {pending.content.writeText}
      </dd>
      <dt>品質</dt>
      <dd>{pending.content.quality}</dd>
    </dl>
    <div class="actions">
      <button
        type="button"
        bind:this={cancelButton}
        onclick={() => (pending = null)}>取消</button
      ><button type="button" class="execute" onclick={execute}>実行</button>
    </div>
  {/if}
</Modal>

<style>
  .operation-rows {
    margin-top: 12px;
    border-top: 1px solid var(--banto-border);
    padding-top: 10px;
  }
  h4 {
    margin: 0 0 8px;
  }
  p {
    margin: 4px 0;
  }
  .banner {
    padding: 4px 8px;
    border-radius: 4px;
    background: var(--banto-warning-bg, var(--banto-surface));
    color: var(--banto-text);
  }
  .disabled,
  .value {
    color: var(--banto-text-muted);
  }
  .error {
    color: var(--banto-danger, var(--banto-text));
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    border-top: 1px solid var(--banto-border);
    padding: 8px 0;
    overflow-wrap: anywhere;
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .value {
    font-variant-numeric: tabular-nums;
  }
  .controls,
  form {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  input {
    width: 8em;
  }
  .confirm {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    margin: 0 0 16px;
  }
  .confirm dt {
    color: var(--banto-text-muted);
  }
  .confirm dd {
    margin: 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
