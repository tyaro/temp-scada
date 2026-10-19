<script lang="ts" module>
  export type FolderOperation =
    "create" | "rename" | "move" | "assign" | "remove";
  export type FolderRequest = {
    kind: FolderOperation;
    folderId?: string;
    objectIds: string[];
  };
</script>

<script lang="ts">
  import { untrack, tick } from "svelte";
  import { Modal } from "@banto/ui";
  import type { Project, Screen, SymbolDefinition } from "../project";
  import type { EditCommand } from "../editor";
  import { commonFolderId, folderDestinations, folderPath } from "./layer-tree";
  import { placementLabel } from "../placement-label";
  let {
    owner,
    project,
    request,
    onapply,
    onclose,
  }: {
    owner: Screen | SymbolDefinition;
    project: Project;
    request: FolderRequest;
    onapply: (command: EditCommand) => string | null;
    onclose: () => void;
  } = $props();
  const initial = untrack(() => ({ owner, request }));
  const folder = initial.owner.folders.find(
    (folder) => folder.id === initial.request.folderId,
  );
  let name = $state(
    untrack(() =>
      initial.request.kind === "create" ? "" : (folder?.name ?? ""),
    ),
  );
  const initialFolder = commonFolderId(
    initial.owner.objects.filter((object) =>
      initial.request.objectIds.includes(object.id),
    ),
  );
  let parent = $state(
    initial.request.kind === "create"
      ? (initial.request.folderId ?? "")
      : initial.request.kind === "assign"
        ? (initialFolder ?? "__choose__")
        : (folder?.parentId ?? ""),
  );
  let error = $state("");
  let composing = false;
  const titles = {
    create: "フォルダーを作成",
    rename: "フォルダー名を変更",
    move: "親フォルダーを変更",
    assign: "配置の所属を変更",
    remove: "空のフォルダーを削除",
  };
  const confirms = {
    create: "作成",
    rename: "名前を変更",
    move: "親を変更",
    assign: "所属を変更",
    remove: "削除",
  };
  const objects = $derived(
    owner.objects.filter((object) => request.objectIds.includes(object.id)),
  );
  const currentFolder = $derived(commonFolderId(objects));
  const assignmentBlocked = $derived(
    request.kind === "assign" &&
      (parent === "__choose__" || currentFolder === parent),
  );
  const hiddenCount = $derived(
    objects.filter((object) => object.visible === false).length,
  );
  const children = $derived(
    owner.folders.filter((child) => child.parentId === folder?.id).length,
  );
  const placements = $derived(
    owner.objects.filter((object) => object.folderId === folder?.id).length,
  );
  const nonempty = $derived(
    request.kind === "remove" && (children > 0 || placements > 0),
  );
  const destinations = $derived(
    folderDestinations(
      owner.folders,
      request.kind === "move" ? request.folderId : undefined,
      request.kind === "create",
    ),
  );
  function prepare(form: HTMLFormElement) {
    const focus = () => {
      const input = form.querySelector<HTMLInputElement | HTMLSelectElement>(
        "input,select",
      );
      input?.focus();
      if (input instanceof HTMLInputElement) input.select();
    };
    let active = true;
    void tick().then(() =>
      requestAnimationFrame(() => {
        if (active) focus();
      }),
    );
    const protect = (event: InputEvent) => {
      if (
        ["historyUndo", "historyRedo"].includes(event.inputType) &&
        !(event.target instanceof Node && form.contains(event.target))
      ) {
        event.preventDefault();
        focus();
      }
    };
    window.addEventListener("beforeinput", protect, true);
    return {
      destroy() {
        active = false;
        window.removeEventListener("beforeinput", protect, true);
      },
    };
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (composing || nonempty || assignmentBlocked) return;
    let command: EditCommand;
    const common = { screenId: owner.id };
    if (request.kind === "create")
      command = {
        ...common,
        type: "create-folder",
        name,
        parentId: parent || null,
      };
    else if (request.kind === "rename")
      command = {
        ...common,
        type: "rename-folder",
        folderId: request.folderId!,
        name,
      };
    else if (request.kind === "move")
      command = {
        ...common,
        type: "move-folder",
        folderId: request.folderId!,
        parentId: parent || null,
      };
    else if (request.kind === "remove")
      command = {
        ...common,
        type: "remove-folder",
        folderId: request.folderId!,
      };
    else
      command = {
        ...common,
        type: "set-folder",
        objectIds: request.objectIds,
        folderId: parent || null,
      };
    error = onapply(command) ?? "";
  }
</script>

<Modal open title={titles[request.kind]} {onclose}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (フォーム内のIME確定をsubmitへ流さない) -->
  <form
    use:prepare
    onsubmit={submit}
    oncompositionstart={() => (composing = true)}
    oncompositionend={() => (composing = false)}
    onkeydown={(event) => {
      if (
        event.key === "Enter" &&
        (event.isComposing || composing || event.keyCode === 229)
      )
        event.preventDefault();
    }}
  >
    <p class="owner">
      対象：{owner.name}{#if folder}
        ／ {folderPath(owner.folders, folder.id)}{/if}
    </p>
    {#if request.kind === "assign"}
      <p>
        {objects.length} 件の配置{#if hiddenCount}（非表示 {hiddenCount} 件）{/if}。座標・描画順・表示は変わりません。
      </p>
      <p class="hint">
        現在の所属：{currentFolder === undefined
          ? "複数の所属"
          : currentFolder
            ? folderPath(owner.folders, currentFolder)
            : "ルート（フォルダーなし）"}
      </p>
      <ul aria-label="所属を変更する配置">
        {#each objects as object}<li>
            {placementLabel(object, project.symbols)}
          </li>{/each}
      </ul>
    {/if}
    {#if request.kind === "create" || request.kind === "rename"}
      <label
        >フォルダー名<input
          bind:value={name}
          maxlength="200"
          required
          autocomplete="off"
        /></label
      >
    {/if}
    {#if ["create", "move", "assign"].includes(request.kind)}
      <label
        >{request.kind === "assign" ? "移動先" : "親フォルダー"}<select
          aria-label={request.kind === "assign" ? "移動先" : "親フォルダー"}
          bind:value={parent}
          >{#if request.kind === "assign" && initialFolder === undefined}<option
              value="__choose__"
              disabled>移動先を選択してください</option
            >{/if}{#each destinations as destination}<option
              value={destination.id}
              disabled={destination.disabled}
              >{destination.label}{destination.disabled
                ? "（深さの上限）"
                : ""}</option
            >{/each}</select
        ></label
      >
      {#if request.kind === "assign"}<p class="hint">
          ルートを選ぶとフォルダーへの所属を解除します。新規配置・貼り付けの所属先は常にルートです。
        </p>{/if}
    {/if}
    {#if request.kind === "remove"}
      {#if nonempty}<p role="status">
          配置 {placements} 件・子フォルダー {children} 件があるため削除できません。所属を変更し、空にしてから削除してください。
        </p>{:else}<p>空のフォルダーを削除します。Undoで戻せます。</p>{/if}
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="actions">
      <button type="button" onclick={onclose}>キャンセル</button><button
        type="submit"
        disabled={!!nonempty || assignmentBlocked}
        >{confirms[request.kind]}</button
      >
    </div>
  </form>
</Modal>

<style>
  form {
    display: grid;
    gap: 14px;
  }
  p {
    margin: 0;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .owner,
  .hint {
    color: var(--banto-text-muted);
    font-size: 12px;
  }
  label {
    display: grid;
    gap: 6px;
    font-size: 13px;
  }
  input,
  select {
    width: 100%;
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    border-radius: 4px;
    font: inherit;
  }
  ul {
    margin: 0;
    max-height: 150px;
    overflow: auto;
    padding-left: 24px;
    font-size: 12px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  button {
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    padding: 7px 14px;
    border-radius: 4px;
    cursor: pointer;
  }
  button[type="submit"] {
    background: var(--banto-primary-solid);
    color: var(--banto-on-solid);
  }
  button[type="submit"]:hover:not(:disabled) {
    background: var(--banto-primary-solid-hover);
  }
  input:focus-visible,
  select:focus-visible,
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  [role="alert"] {
    color: var(--banto-danger, #b91c1c);
  }
</style>
