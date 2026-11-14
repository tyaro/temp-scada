<script lang="ts">
  import {
    ALARM_ACK_MODES,
    ALARM_LIMIT_KEYS,
    ALARM_SEVERITIES,
    MAX_ALARM_DEFINITIONS,
    newAlarmDefinition,
    type AlarmDefinition,
  } from "../alarms";
  import { alarmDefinitionFormValues } from "./forms/alarm-definition-form";
  import { newId } from "../editor/model-helpers";
  import type { Project } from "../project";
  import type { EditCommand } from "../editor";
  import type { createDraftGuard } from "./drafts.svelte";

  /** 「プロジェクト設定」の「警報の設定」。一覧で追加・複製・削除・有効の切替、選んだ行を下の詳細で編集する。 */
  let {
    project,
    generation,
    drafts,
    disabled,
    tagNames = [],
    oncommand,
    onsubmit,
  }: {
    project: Project;
    generation: number;
    drafts: ReturnType<typeof createDraftGuard>;
    disabled: boolean;
    /** 入力候補（タグ一覧の外部名）。 */
    tagNames?: readonly string[];
    oncommand: (command: EditCommand) => boolean;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();

  const definitions = $derived(project.alarms?.definitions ?? []);
  let selectedId = $state<string | null>(null);
  const selected = $derived(
    definitions.find((row) => row.id === selectedId) ?? null,
  );
  const full = $derived(definitions.length >= MAX_ALARM_DEFINITIONS);
  const listId = `alarm-tags-${Math.random().toString(36).slice(2)}`;

  /** 未適用の入力があれば先に確定してから行う（drafts.allow は確定待ちのとき後で呼ぶ）。 */
  function guard(action: () => unknown) {
    if (drafts.allow(action)) action();
  }
  function current(id: string) {
    return project.alarms?.definitions.find((row) => row.id === id);
  }
  function add(kind: "threshold" | "bit") {
    guard(() => {
      const id = newId();
      const definition = newAlarmDefinition(project, kind, id);
      if (oncommand({ type: "add-alarm-definition", definition }))
        selectedId = id;
    });
  }
  function duplicate(id: string) {
    guard(() => {
      const copyId = newId();
      if (
        oncommand({
          type: "duplicate-alarm-definition",
          definitionId: id,
          id: copyId,
        })
      )
        selectedId = copyId;
    });
  }
  function remove(id: string) {
    guard(() => {
      const at = definitions.findIndex((row) => row.id === id);
      if (!oncommand({ type: "remove-alarm-definition", definitionId: id }))
        return;
      const rest = project.alarms?.definitions ?? [];
      selectedId = rest[Math.min(at, rest.length - 1)]?.id ?? null;
    });
  }
  function toggle(event: Event, id: string) {
    const input = event.currentTarget as HTMLInputElement;
    const enabled = input.checked;
    // 結果は Project から描き直す。適用されなければ元の表示へ戻す。
    input.checked = !enabled;
    guard(() => {
      const definition = current(id);
      if (definition)
        oncommand({
          type: "update-alarm-definition",
          definition: { ...definition, enabled },
        });
    });
  }
  function choose(id: string) {
    if (id !== selectedId) guard(() => (selectedId = id));
  }
  const kindLabel = (row: AlarmDefinition) =>
    row.source.kind === "bit" ? "bit" : "しきい値";
</script>

<div class="alarm-settings">
  <label class="blink"
    ><input
      type="checkbox"
      checked={project.alarms?.blinkUnacked ?? false}
      {disabled}
      onchange={(event) => {
        const input = event.currentTarget;
        const blinkUnacked = input.checked;
        input.checked = !blinkUnacked;
        guard(() => oncommand({ type: "set-alarm-blink", blinkUnacked }));
      }}
    />未確認の警報を点滅する</label
  >
  <div class="actions" role="group" aria-label="警報の定義の追加">
    <button disabled={disabled || full} onclick={() => add("threshold")}
      >しきい値の警報を追加</button
    >
    <button disabled={disabled || full} onclick={() => add("bit")}
      >bit の警報を追加</button
    >
  </div>
  {#if definitions.length}
    <div class="scroll">
      <table aria-label="警報の定義">
        <thead
          ><tr
            ><th scope="col">有効</th><th scope="col">名前</th><th scope="col"
              >種類</th
            ></tr
          ></thead
        >
        <tbody>
          {#each definitions as row (row.id)}
            <tr
              data-alarm-id={row.id}
              class:selected={row.id === selectedId}
              aria-selected={row.id === selectedId}
            >
              <td
                ><input
                  type="checkbox"
                  aria-label={`${row.name} を有効にする`}
                  checked={row.enabled}
                  {disabled}
                  onchange={(event) => toggle(event, row.id)}
                /></td
              >
              <th scope="row"
                ><button
                  class="name"
                  aria-label={`${row.name} を選ぶ`}
                  aria-pressed={row.id === selectedId}
                  onclick={() => choose(row.id)}>{row.name}</button
                ></th
              >
              <td>{kindLabel(row)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="hint">警報の定義はありません。</p>
  {/if}
  {#if selected}
    {@const row = selected}
    <div class="actions" role="group" aria-label="選んだ警報の定義">
      <button disabled={disabled || full} onclick={() => duplicate(row.id)}
        >警報を複製</button
      >
      <button {disabled} onclick={() => remove(row.id)}>警報を削除</button>
    </div>
    {#key `${generation}:${row.id}`}
      <form
        use:drafts.track={alarmDefinitionFormValues(row)}
        data-editor-form="alarm-definition"
        data-alarm-id={row.id}
        aria-label="警報の定義の詳細"
        {onsubmit}
      >
        <p class="hint">種類: {kindLabel(row)}</p>
        <label class="banto-field banto-field--stacked"
          ><span class="banto-field-label">名前</span><input
            class="banto-field-control"
            name="name"
            required
            maxlength="100"
            {disabled}
          /></label
        >
        <label class="banto-field banto-field--stacked"
          ><span class="banto-field-label">タグの外部名</span><input
            class="banto-field-control"
            name="tag"
            required
            maxlength="1024"
            list={listId}
            {disabled}
          /></label
        >
        {#if row.source.kind === "threshold"}
          {#each ALARM_LIMIT_KEYS as key (key)}
            {@const label = key.toUpperCase()}
            <fieldset class="limit">
              <legend>{label}</legend>
              <label class="banto-field banto-field--stacked"
                ><span class="banto-field-label">{label} の値</span><input
                  class="banto-field-control"
                  name={`${key}.value`}
                  inputmode="decimal"
                  placeholder="使わない"
                  {disabled}
                /></label
              >
              <label class="banto-field banto-field--stacked"
                ><span class="banto-field-label">{label} の重要度</span><select
                  class="banto-field-control"
                  name={`${key}.severity`}
                  aria-label={`${label} の重要度`}
                  {disabled}
                  >{#each ALARM_SEVERITIES as [value, text] (value)}<option
                      {value}>{text}</option
                    >{/each}</select
                ></label
              >
              <label class="banto-field banto-field--stacked"
                ><span class="banto-field-label">{label} のメッセージ</span
                ><input
                  class="banto-field-control"
                  name={`${key}.message`}
                  maxlength="200"
                  {disabled}
                /></label
              >
            </fieldset>
          {/each}
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">deadband</span><input
              class="banto-field-control"
              name="deadband"
              inputmode="decimal"
              placeholder="なし"
              {disabled}
            /></label
          >
        {:else}
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">発生の条件</span><select
              class="banto-field-control"
              name="activeWhen"
              aria-label="発生の条件"
              {disabled}
              ><option value="true">ON で発生</option><option value="false"
                >OFF で発生</option
              ></select
            ></label
          >
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">重要度</span><select
              class="banto-field-control"
              name="severity"
              aria-label="重要度"
              {disabled}
              >{#each ALARM_SEVERITIES as [value, text] (value)}<option {value}
                  >{text}</option
                >{/each}</select
            ></label
          >
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">メッセージ</span><input
              class="banto-field-control"
              name="message"
              maxlength="200"
              {disabled}
            /></label
          >
        {/if}
        <label class="banto-field banto-field--stacked"
          ><span class="banto-field-label">発生の遅延（ms）</span><input
            class="banto-field-control"
            name="onDelayMs"
            inputmode="numeric"
            placeholder="0"
            {disabled}
          /></label
        >
        <label class="banto-field banto-field--stacked"
          ><span class="banto-field-label">復帰の遅延（ms）</span><input
            class="banto-field-control"
            name="offDelayMs"
            inputmode="numeric"
            placeholder="0"
            {disabled}
          /></label
        >
        <label class="banto-field banto-field--stacked"
          ><span class="banto-field-label">ACK の種類</span><select
            class="banto-field-control"
            name="ackMode"
            aria-label="ACK の種類"
            {disabled}
            >{#each ALARM_ACK_MODES as [value, text] (value)}<option {value}
                >{text}</option
              >{/each}</select
          ></label
        >
        <p class="hint">
          限界は HH ≥ H &gt; L ≥ LL。値を空にした限界は使いません。
        </p>
        <button type="submit" {disabled}>警報の定義を適用</button>
      </form>
    {/key}
  {/if}
  <datalist id={listId}
    >{#each tagNames as name (name)}<option value={name}
      ></option>{/each}</datalist
  >
</div>

<style>
  .alarm-settings {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  .blink {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .scroll {
    max-height: 240px;
    overflow: auto;
    border: 1px solid var(--banto-border);
    border-radius: 6px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th,
  td {
    padding: 4px 6px;
    text-align: left;
    border-bottom: 1px solid var(--banto-border);
  }
  tr.selected {
    background: var(--banto-primary-tint);
    outline: 2px solid var(--banto-primary);
    outline-offset: -2px;
  }
  .name {
    all: unset;
    cursor: pointer;
    word-break: break-all;
  }
  .name:focus-visible {
    outline: 2px solid var(--banto-focus-ring);
  }
  .limit {
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    padding: 4px 8px 8px;
    margin: 0;
  }
  .hint {
    color: var(--banto-text-muted);
    font-size: 12px;
    margin: 0;
  }
</style>
