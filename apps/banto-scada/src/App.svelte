<script lang="ts">
  import { PageHeader, SurfaceCard, StatusBadge, ToastHost } from "@banto/ui";
  import { notify, type NotificationKind } from "@banto/admin-core";
  import { isThemeMode } from "@banto/theme";
  import { getThemeMode, setThemeMode, toastStore } from "./lib/banto/setup";
  let theme = $state(getThemeMode());
  function changeTheme(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (isThemeMode(value)) {
      theme = value;
      void setThemeMode(value);
    }
  }
  import sample from "../../../examples/minimal.project.json";
  import processSample from "../../../examples/process.project.json";
  import Renderer from "./lib/Renderer.svelte";
  import { parseProject, serializeProject, parsePoints } from "./lib/project";
  import {
    type EditCommand,
    type AddKind,
    type ObjectPatch,
  } from "./lib/editor";
  import {
    emptyHistory,
    recordEdit,
    travelHistory,
    type EditHistory,
  } from "./lib/history";
  let history = $state<EditHistory>(emptyHistory());
  let showGrid = $state(false),
    snapEnabled = $state(false),
    gridSize = $state(10);
  function travel(direction: "undo" | "redo") {
    try {
      const result = travelHistory(project, history, direction, mode);
      if (result.project === project) return;
      project = result.project;
      history = result.history;
      projectChanged = true;
      if (!project.screens.some((s) => s.id === screenId))
        screenId = project.screens[0].id;
      selectedIds = selectedIds.filter((id) =>
        screen.objects.some((o) => o.id === id),
      );
      report(
        "info",
        direction === "undo" ? "元に戻しました。" : "やり直しました。",
      );
    } catch (e) {
      report(
        "error",
        `履歴エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  function shortcut(event: KeyboardEvent) {
    if (
      mode !== "edit" ||
      busy ||
      event.isComposing ||
      event.altKey ||
      !(event.ctrlKey || event.metaKey)
    )
      return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input,textarea,select,[contenteditable]")
    )
      return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      travel(event.shiftKey ? "redo" : "undo");
    } else if (key === "y" && !event.shiftKey) {
      event.preventDefault();
      travel("redo");
    } else if (key === "a" && !event.shiftKey) {
      event.preventDefault();
      selectedIds = screen.objects.map((o) => o.id);
    } else if (key === "d" && !event.shiftKey && selectedIds.length) {
      event.preventDefault();
      duplicateSelection();
    }
  }
  let mode = $state<"edit" | "preview">("preview");
  let selectedIds = $state<string[]>([]);
  let selectedId = $derived(selectedIds.length === 1 ? selectedIds[0] : null);
  function selectObjects(
    id: string | null,
    additive = false,
    preserve = false,
  ): string[] {
    if (!id) {
      if (!additive) selectedIds = [];
      return [...selectedIds];
    }
    selectedIds = additive
      ? selectedIds.includes(id)
        ? selectedIds.filter((s) => s !== id)
        : [...selectedIds, id]
      : preserve && selectedIds.includes(id)
        ? selectedIds
        : [id];
    return [...selectedIds];
  }
  function duplicateSelection() {
    if (selectedIds.length === 1)
      edit({
        type: "duplicate",
        screenId: screen.id,
        objectId: selectedIds[0],
      });
    else if (selectedIds.length > 1)
      edit({
        type: "duplicate-many",
        screenId: screen.id,
        objectIds: [...selectedIds],
      });
  }
  function removeSelection() {
    if (selectedIds.length)
      edit({
        type: "remove-many",
        screenId: screen.id,
        objectIds: [...selectedIds],
      });
  }
  function moveSelection(event: SubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    edit({
      type: "move-many",
      screenId: screen.id,
      objectIds: [...selectedIds],
      dx: Number(data.get("dx")),
      dy: Number(data.get("dy")),
    });
  }
  let project = $state(parseProject(JSON.stringify(sample)));
  let screenId = $state(sample.screens[0].id);
  let screen = $derived(
    project.screens.find((s) => s.id === screenId) ?? project.screens[0],
  );
  let message = $state("サンプルを表示しています。Hub には接続していません。");
  let busy = $state(false);
  let projectChanged = $state(false);
  function showProcessSample() {
    if (
      projectChanged &&
      !window.confirm(
        "現在の編集内容を工程図サンプルで置き換えます。必要な JSON は保存しましたか？",
      )
    )
      return;
    project = parseProject(JSON.stringify(processSample));
    history = emptyHistory();
    screenId = project.screens[0].id;
    selectedIds = [];
    projectChanged = false;
    report(
      "info",
      "工程図サンプルを開きました。設備や計測値には接続していません。",
    );
  }
  function report(kind: NotificationKind, text: string) {
    message = text;
    notify(kind, text);
  }
  let selected = $derived(screen.objects.find((o) => o.id === selectedId));
  function edit(command: EditCommand) {
    try {
      const oldIds = new Set(screen.objects.map((o) => o.id));
      const oldScreens = new Set(project.screens.map((s) => s.id));
      const result = recordEdit(project, history, command, mode);
      if (result.project === project) return;
      project = result.project;
      history = result.history;
      projectChanged = true;
      if (
        command.type === "create-screen" ||
        command.type === "duplicate-screen"
      ) {
        screenId = project.screens.find((s) => !oldScreens.has(s.id))!.id;
        selectedIds = [];
      } else if (command.type === "remove-screen") {
        screenId = project.screens[0].id;
        selectedIds = [];
      }
      if (
        command.type === "add" ||
        command.type === "add-symbol" ||
        command.type === "duplicate" ||
        command.type === "duplicate-many"
      )
        selectedIds = screen.objects
          .filter((o) => !oldIds.has(o.id))
          .map((o) => o.id);
      if (command.type === "remove" || command.type === "remove-many")
        selectedIds = [];
      report(
        "success",
        "変更を適用しました。JSON を保存するとファイルに残せます。",
      );
    } catch (e) {
      report(
        "error",
        `編集エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  function screenProperties(event: SubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    edit({
      type: "update-screen",
      screenId: screen.id,
      name: String(data.get("name")),
      width: Number(data.get("width")),
      height: Number(data.get("height")),
    });
  }
  function removeScreen() {
    if (window.confirm(`「${screen.name}」と画面内の図形を削除しますか？`))
      edit({ type: "remove-screen", screenId: screen.id });
  }
  function add(kind: AddKind) {
    edit({ type: "add", screenId: screen.id, kind });
  }
  function properties(event: SubmitEvent) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget as HTMLFormElement);
    try {
      const patch: ObjectPatch = {
        x: Number(data.get("x")),
        y: Number(data.get("y")),
        fill: String(data.get("fill")),
      };
      if ("width" in selected) {
        patch.width = Number(data.get("width"));
        patch.height = Number(data.get("height"));
      }
      if (selected.shape.type === "text") patch.text = String(data.get("text"));
      if (selected.shape.type === "polyline") {
        patch.points = parsePoints(String(data.get("points")));
        patch.strokeWidth = Number(data.get("strokeWidth"));
        patch.arrow = data.get("arrow") === "end" ? "end" : "none";
      }
      edit({
        type: "update",
        screenId: screen.id,
        objectId: selected.id,
        patch,
      });
    } catch (e) {
      report(
        "error",
        `編集エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function load(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    busy = true;
    try {
      if (file.size > 1024 * 1024)
        throw new Error("ファイルは 1 MiB 以下にしてください");
      const next = parseProject(await file.text());
      project = next;
      history = emptyHistory();
      projectChanged = false;
      screenId = next.screens[0].id;
      selectedIds = [];
      report("success", "Project を読み込みました。");
    } catch (e) {
      report(
        "error",
        `読込エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      busy = false;
      input.value = "";
    }
  }
  function save() {
    const url = URL.createObjectURL(
      new Blob([serializeProject(project)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "project.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    report("success", "Project JSON を保存しました。");
  }
</script>

<svelte:window onkeydown={shortcut} />

<svelte:head
  ><meta
    name="description"
    content="Banto SCADA の初期 Project エディタ"
  /></svelte:head
>
<div class="app-header">
  <PageHeader
    title={project.manifest.name}
    description="BANTO / SCADA · ローカルファイル編集"
  >
    {#snippet actions()}
      <div class="mode" role="group" aria-label="表示モード">
        <button
          class:active={mode === "edit"}
          aria-pressed={mode === "edit"}
          onclick={() => {
            mode = "edit";
            selectedIds = [];
          }}>編集</button
        >
        <button
          class:active={mode === "preview"}
          aria-pressed={mode === "preview"}
          onclick={() => {
            mode = "preview";
            selectedIds = [];
          }}>表示プレビュー</button
        >
        <StatusBadge variant="neutral" label="Hub 未接続" />
        <label class="theme-label"
          >テーマ<select
            aria-label="テーマ"
            value={theme}
            onchange={changeTheme}
            ><option value="dark">ダーク</option><option value="light"
              >ライト</option
            ><option value="system">システム</option></select
          ></label
        >
      </div>
    {/snippet}
  </PageHeader>
</div>
<main>
  <aside>
    <h2>Project</h2>
    <button onclick={showProcessSample} disabled={busy}
      >工程図サンプルを開く</button
    >
    <p>画面を選んで表示します。</p>
    <nav aria-label="画面一覧">
      {#each project.screens as item}<button
          class:active={screen.id === item.id}
          aria-pressed={screen.id === item.id}
          onclick={() => {
            screenId = item.id;
            selectedIds = [];
          }}>{item.name}</button
        >{/each}
    </nav>
    {#if mode === "edit"}
      <hr />
      <h2>画面管理</h2>
      <button
        disabled={project.screens.length >= 100}
        onclick={() =>
          edit({
            type: "create-screen",
            name: `画面 ${project.screens.length + 1}`,
            width: screen.width,
            height: screen.height,
          })}>画面を追加</button
      >
      <button
        disabled={project.screens.length >= 100}
        onclick={() => edit({ type: "duplicate-screen", screenId: screen.id })}
        >画面を複製</button
      >
      <button disabled={project.screens.length === 1} onclick={removeScreen}
        >画面を削除</button
      >
      {#key screen}
        <form onsubmit={screenProperties} aria-label="画面設定">
          <label
            >画面名<input
              name="name"
              value={screen.name}
              required
              maxlength="200"
            /></label
          >
          <label
            >画面の幅<input
              name="width"
              type="number"
              step="any"
              min="1"
              value={screen.width}
              required
            /></label
          >
          <label
            >画面の高さ<input
              name="height"
              type="number"
              step="any"
              min="1"
              value={screen.height}
              required
            /></label
          >
          <button type="submit">画面設定を適用</button>
        </form>
      {/key}
      <p class="hint">
        サイズ変更は表示領域のみを変更します。図形の位置・サイズは変わりません。
      </p>
      <hr />
      <h2>部品を追加</h2>
      <button onclick={() => add("rectangle")}>Rectangle を追加</button>
      <button onclick={() => add("ellipse")}>Ellipse を追加</button>
      <button onclick={() => add("text")}>Text を追加</button>
      <button onclick={() => add("line")}>線を追加</button><button
        onclick={() => add("pipe")}>配管を追加</button
      >
      <button
        onclick={() =>
          edit({ type: "add-symbol", screenId: screen.id, template: "pump" })}
        >ポンプを追加</button
      >
      <button
        onclick={() =>
          edit({ type: "add-symbol", screenId: screen.id, template: "valve" })}
        >バルブを追加</button
      >
      <h2>図形一覧</h2>
      <nav aria-label="図形一覧">
        {#each [...screen.objects].sort((a, b) => a.order - b.order) as object}<button
            class:active={selectedIds.includes(object.id)}
            aria-pressed={selectedIds.includes(object.id)}
            onclick={(event) => selectObjects(object.id, event.shiftKey)}
            >{object.shape.type === "symbol"
              ? project.symbols.find(
                  (s) =>
                    object.shape.type === "symbol" &&
                    s.id === object.shape.symbolId,
                )?.name
              : object.shape.type} · {object.order}</button
          >{/each}
      </nav>
    {/if}
    <hr />
    <label class="file"
      >Project JSON を開く<input
        aria-label="Project JSON を開く"
        type="file"
        accept=".json,application/json"
        disabled={busy}
        onchange={load}
      /></label
    ><button onclick={save} disabled={busy}>Project JSON を保存</button>
    <p class="hint">
      編集した Project は JSON
      を保存してください。表示プレビューは見た目の確認用です。設備接続や正式な
      Runtime の権限分離は未実装です。
    </p>
  </aside>
  <section aria-label="画面プレビュー">
    <div class="toolbar">
      <h2>{screen.name}</h2>
      <span>{screen.width} × {screen.height}</span>
    </div>
    {#if mode === "edit"}
      <div class="edit-toolbar" role="group" aria-label="編集履歴">
        <button
          disabled={busy || history.past.length === 0}
          onclick={() => travel("undo")}>元に戻す</button
        >
        <button
          disabled={busy || history.future.length === 0}
          onclick={() => travel("redo")}>やり直す</button
        >
        <button onclick={() => (selectedIds = screen.objects.map((o) => o.id))}
          >すべて選択</button
        >
        <button
          disabled={selectedIds.length === 0}
          onclick={() => (selectedIds = [])}>選択解除</button
        >
        <span>Shift + クリックで複数選択 · {selectedIds.length} 件選択</span>
      </div>
    {/if}
    {#if mode === "edit"}
      <div class="grid-tools" role="group" aria-label="グリッドとスナップ">
        <label
          ><input type="checkbox" bind:checked={showGrid} />グリッド表示</label
        >
        <label
          ><input
            type="checkbox"
            bind:checked={snapEnabled}
          />グリッドにスナップ</label
        >
        <label
          >グリッド間隔<select aria-label="グリッド間隔" bind:value={gridSize}
            >{#each [5, 10, 20, 50] as size}<option value={size}
                >{size} unit</option
              >{/each}</select
          ></label
        >
        <span
          >Alt を押してドラッグするとスナップを一時解除 · Esc でドラッグを取消</span
        >
      </div>
    {/if}
    <div class="canvas" style:aspect-ratio={`${screen.width}/${screen.height}`}>
      {#key screen.id}
        <Renderer
          {screen}
          symbols={project.symbols}
          editable={mode === "edit"}
          {selectedIds}
          {showGrid}
          {snapEnabled}
          {gridSize}
          onresize={(id, geometry) =>
            edit({
              type: "update",
              screenId: screen.id,
              objectId: id,
              patch: geometry,
            })}
          onvertexmove={(id, index, point) =>
            edit({
              type: "move-vertex",
              screenId: screen.id,
              objectId: id,
              index,
              point,
            })}
          onselect={selectObjects}
          onmove={(ids, dx, dy) =>
            edit({
              type: "move-many",
              screenId: screen.id,
              objectIds: ids,
              dx,
              dy,
            })}
        />
      {/key}
    </div>
    {#if mode === "edit"}
      <div class="inspector">
        <SurfaceCard title="プロパティ">
          {#if selectedIds.length > 1}
            <p>
              {selectedIds.length} 件選択しています。図形をドラッグするとまとめて移動します。
            </p>
            <form onsubmit={moveSelection}>
              <div class="fields">
                <label
                  >移動量 X<input
                    name="dx"
                    aria-label="移動量 X"
                    type="number"
                    step="any"
                    required
                    value="0"
                  /></label
                ><label
                  >移動量 Y<input
                    name="dy"
                    aria-label="移動量 Y"
                    type="number"
                    step="any"
                    required
                    value="0"
                  /></label
                >
              </div>
              <div class="actions">
                <button type="submit">まとめて移動</button><button
                  type="button"
                  onclick={duplicateSelection}>選択図形を複製</button
                ><button type="button" onclick={removeSelection}
                  >選択図形を削除</button
                >
              </div>
            </form>
            <div class="actions" role="group" aria-label="整列">
              {#each [{ alignment: "left" as const, label: "左揃え" }, { alignment: "center-x" as const, label: "左右中央揃え" }, { alignment: "right" as const, label: "右揃え" }, { alignment: "top" as const, label: "上揃え" }, { alignment: "center-y" as const, label: "上下中央揃え" }, { alignment: "bottom" as const, label: "下揃え" }] as item}<button
                  onclick={() =>
                    edit({
                      type: "align",
                      screenId: screen.id,
                      objectIds: [...selectedIds],
                      alignment: item.alignment,
                    })}>{item.label}</button
                >{/each}
            </div>
          {:else if selected}
            {#key project.manifest.projectRevision + selected.id}
              <form onsubmit={properties}>
                <div class="fields">
                  {#each "width" in selected ? ["x", "y", "width", "height"] : ["x", "y"] as field}
                    <label
                      >{field}<input
                        name={field}
                        aria-label={field}
                        type="number"
                        step="any"
                        required
                        min={field === "width" || field === "height"
                          ? 0.001
                          : undefined}
                        value={field === "x"
                          ? selected.x
                          : field === "y"
                            ? selected.y
                            : "width" in selected
                              ? selected[field as "width" | "height"]
                              : 0}
                      /></label
                    >
                  {/each}
                  <label
                    >色<input
                      name="fill"
                      aria-label="色"
                      type="color"
                      value={selected.fill}
                    /></label
                  >
                  {#if selected.shape.type === "polyline"}
                    <label
                      >頂点（x,y を1行ずつ）<textarea
                        name="points"
                        aria-label="頂点"
                        rows="5"
                        required
                        value={selected.shape.points
                          .map((p) => `${p.x},${p.y}`)
                          .join("\n")}></textarea></label
                    >
                    <label
                      >線幅<input
                        name="strokeWidth"
                        aria-label="線幅"
                        type="number"
                        required
                        min="0.1"
                        max="64"
                        step="any"
                        value={selected.shape.strokeWidth}
                      /></label
                    >
                    <label
                      >矢印<select
                        name="arrow"
                        aria-label="矢印"
                        value={selected.shape.arrow}
                        ><option value="none">なし</option><option value="end"
                          >終点</option
                        ></select
                      ></label
                    >
                  {/if}
                  {#if selected.shape.type === "text"}<label
                      >テキスト<input
                        name="text"
                        aria-label="テキスト"
                        maxlength="1000"
                        value={selected.shape.text}
                      /></label
                    >{/if}
                </div>
                <div class="actions">
                  <button type="submit">変更を適用</button>
                  <button
                    type="button"
                    onclick={() =>
                      selected &&
                      edit({
                        type: "duplicate",
                        screenId: screen.id,
                        objectId: selected.id,
                      })}>選択図形を複製</button
                  ><button
                    type="button"
                    onclick={() =>
                      selected &&
                      edit({
                        type: "remove",
                        screenId: screen.id,
                        objectId: selected.id,
                      })}>選択図形を削除</button
                  >
                </div>
                <div class="actions" role="group" aria-label="重なり順">
                  {#each [{ direction: "back" as const, label: "最背面へ" }, { direction: "backward" as const, label: "1つ背面へ" }, { direction: "forward" as const, label: "1つ前面へ" }, { direction: "front" as const, label: "最前面へ" }] as layer}
                    <button
                      type="button"
                      onclick={() =>
                        selected &&
                        edit({
                          type: "reorder",
                          screenId: screen.id,
                          objectId: selected.id,
                          direction: layer.direction,
                        })}>{layer.label}</button
                    >
                  {/each}
                </div>
              </form>
            {/key}
          {:else}<p>
              図形をクリック、または一覧から選んでください。図形はドラッグして移動できます。
            </p>{/if}
        </SurfaceCard>
      </div>
    {/if}
    <p role="status" data-testid="project-status">{message}</p>
  </section>
</main>
<ToastHost store={toastStore} />

<style>
  :global(body) {
    margin: 0;
    background: var(--banto-bg);
    color: var(--banto-text);
    font-family: var(--banto-font-family);
  }
  :global(*) {
    box-sizing: border-box;
  }
  .app-header {
    padding: 24px 32px;
    border-bottom: 1px solid var(--banto-border);
  }
  .theme-label {
    display: grid;
    gap: 4px;
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  .theme-label select {
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: var(--banto-radius);
    padding: 6px;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  .mode {
    flex-wrap: wrap;
  }
  .actions {
    flex-wrap: wrap;
  }
  .grid-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  .grid-tools label {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .grid-tools select {
    background: var(--banto-surface);
    color: var(--banto-text);
    padding: 5px;
    border: 1px solid var(--banto-border);
    border-radius: var(--banto-radius);
  }
  .edit-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .edit-toolbar button {
    width: auto;
    margin: 0;
  }
  .edit-toolbar span {
    color: var(--banto-text-muted);
    font-size: 12px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .mode,
  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .mode button,
  .actions button {
    width: auto;
    white-space: nowrap;
  }
  .inspector {
    margin-top: 20px;
    border-radius: var(--banto-radius);
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: 12px;
    margin-top: 16px;
  }
  .fields label {
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  .fields input,
  .fields textarea,
  .fields select {
    display: block;
    width: 100%;
    min-height: 36px;
    margin-top: 6px;
    background: var(--banto-bg);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    padding: 6px;
    border-radius: 4px;
  }
  h2 {
    font-size: 15px;
    margin: 0;
  }
  main {
    display: grid;
    grid-template-columns: 260px 1fr;
    min-height: calc(100vh - 108px);
  }
  aside {
    padding: 24px;
    border-right: 1px solid var(--banto-border);
  }
  p {
    font-size: 13px;
    line-height: 1.8;
    color: var(--banto-text-muted);
  }
  button,
  .file {
    display: block;
    width: 100%;
    text-align: left;
    padding: 12px;
    margin: 12px 0;
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .active {
    border-color: var(--banto-primary);
    color: var(--banto-primary);
  }
  .file input {
    display: block;
    width: 100%;
    margin-top: 10px;
    font-size: 11px;
  }
  hr {
    border: 0;
    border-top: 1px solid var(--banto-border);
    margin: 28px 0;
  }
  .hint {
    margin-top: 28px;
  }
  section {
    padding: 24px;
    min-width: 0;
  }
  .toolbar {
    display: flex;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .toolbar span {
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  .canvas {
    aspect-ratio: 16/9;
    border: 1px solid var(--banto-border);
    border-radius: 8px;
    overflow: hidden;
  }
  section p {
    overflow-wrap: anywhere;
  }
  @media (max-width: 700px) {
    main {
      grid-template-columns: 1fr;
    }
    aside {
      border-right: 0;
      border-bottom: 1px solid var(--banto-border);
    }
    .app-header {
      padding: 20px;
      gap: 16px;
      flex-wrap: wrap;
    }
  }
</style>
