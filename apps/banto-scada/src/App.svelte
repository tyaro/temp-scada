<script lang="ts">
  import sample from "../../../examples/minimal.project.json";
  import Renderer from "./lib/Renderer.svelte";
  import { parseProject, serializeProject } from "./lib/project";
  import { applyCommand, type EditCommand } from "./lib/editor";
  import type { ScreenObject } from "./lib/project";
  let mode = $state<"edit" | "preview">("preview");
  let selectedId = $state<string | null>(null);
  let project = $state(parseProject(JSON.stringify(sample)));
  let screenId = $state(sample.screens[0].id);
  let screen = $derived(
    project.screens.find((s) => s.id === screenId) ?? project.screens[0],
  );
  let message = $state("サンプルを表示しています。Hub には接続していません。");
  let busy = $state(false);
  let selected = $derived(screen.objects.find((o) => o.id === selectedId));
  function edit(command: EditCommand) {
    try {
      project = applyCommand(project, command, mode);
      if (command.type === "add")
        selectedId = project.screens
          .find((s) => s.id === screenId)!
          .objects.at(-1)!.id;
      if (command.type === "remove") selectedId = null;
      message = "変更を適用しました。JSON を保存するとファイルに残せます。";
    } catch (e) {
      message = `編集エラー: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  function add(kind: ScreenObject["shape"]["type"]) {
    edit({ type: "add", screenId: screen.id, kind });
  }
  function properties(event: SubmitEvent) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const patch: {
      x: number;
      y: number;
      width: number;
      height: number;
      fill: string;
      text?: string;
    } = {
      x: Number(data.get("x")),
      y: Number(data.get("y")),
      width: Number(data.get("width")),
      height: Number(data.get("height")),
      fill: String(data.get("fill")),
    };
    if (selected.shape.type === "text") patch.text = String(data.get("text"));
    edit({ type: "update", screenId: screen.id, objectId: selected.id, patch });
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
      screenId = next.screens[0].id;
      selectedId = null;
      message = "Project を読み込みました。";
    } catch (e) {
      message = `読込エラー: ${e instanceof Error ? e.message : String(e)}`;
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
    message = "Project JSON を保存しました。";
  }
</script>

<svelte:head
  ><meta
    name="description"
    content="Banto SCADA の初期 Project エディタ"
  /></svelte:head
>
<header>
  <div>
    <span class="brand">BANTO / SCADA</span>
    <h1>{project.manifest.name}</h1>
  </div>
  <div class="mode" role="group" aria-label="表示モード">
    <button
      class:active={mode === "edit"}
      aria-pressed={mode === "edit"}
      onclick={() => {
        mode = "edit";
        selectedId = null;
      }}>編集</button
    >
    <button
      class:active={mode === "preview"}
      aria-pressed={mode === "preview"}
      onclick={() => {
        mode = "preview";
        selectedId = null;
      }}>表示プレビュー</button
    >
    <span class="badge">Hub 未接続</span>
  </div>
</header>
<main>
  <aside>
    <h2>Project</h2>
    <p>画面を選んで表示します。</p>
    <nav aria-label="画面一覧">
      {#each project.screens as item}<button
          class:active={screen.id === item.id}
          onclick={() => {
            screenId = item.id;
            selectedId = null;
          }}>{item.name}</button
        >{/each}
    </nav>
    {#if mode === "edit"}
      <hr />
      <h2>部品を追加</h2>
      <button onclick={() => add("rectangle")}>Rectangle を追加</button>
      <button onclick={() => add("ellipse")}>Ellipse を追加</button>
      <button onclick={() => add("text")}>Text を追加</button>
      <h2>図形一覧</h2>
      <nav aria-label="図形一覧">
        {#each [...screen.objects].sort((a, b) => a.order - b.order) as object}<button
            class:active={selectedId === object.id}
            onclick={() => (selectedId = object.id)}
            >{object.shape.type} · {object.order}</button
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
    <div class="canvas" style:aspect-ratio={`${screen.width}/${screen.height}`}>
      <Renderer
        {screen}
        editable={mode === "edit"}
        {selectedId}
        onselect={(id) => (selectedId = id)}
        onmove={(id, x, y) =>
          edit({
            type: "update",
            screenId: screen.id,
            objectId: id,
            patch: { x, y },
          })}
      />
    </div>
    {#if mode === "edit"}
      <div class="inspector">
        <h2>プロパティ</h2>
        {#if selected}
          {#key project.manifest.projectRevision + selected.id}
            <form onsubmit={properties}>
              <div class="fields">
                {#each ["x", "y", "width", "height"] as field}
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
                      value={selected[field as "x" | "y" | "width" | "height"]}
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
                <button type="submit">変更を適用</button><button
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
            </form>
          {/key}
        {:else}<p>
            図形をクリック、または一覧から選んでください。図形はドラッグして移動できます。
          </p>{/if}
      </div>
    {/if}
    <p role="status">{message}</p>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #101827;
    color: #e2e8f0;
    font-family: system-ui, sans-serif;
  }
  :global(*) {
    box-sizing: border-box;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 24px 32px;
    border-bottom: 1px solid #334155;
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
    border: 1px solid #334155;
    padding: 16px;
    border-radius: 8px;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: 12px;
    margin-top: 16px;
  }
  .fields label {
    font-size: 12px;
    color: #b5c5d8;
  }
  .fields input {
    display: block;
    width: 100%;
    height: 36px;
    margin-top: 6px;
    background: #101827;
    color: #e2e8f0;
    border: 1px solid #475569;
    padding: 6px;
    border-radius: 4px;
  }
  .brand {
    color: #5eead4;
    font-size: 12px;
    letter-spacing: 3px;
  }
  h1 {
    font-size: 22px;
    margin: 8px 0 0;
  }
  h2 {
    font-size: 15px;
    margin: 0;
  }
  .badge {
    background: #263448;
    padding: 8px 12px;
    border-radius: 20px;
    font-size: 12px;
  }
  main {
    display: grid;
    grid-template-columns: 260px 1fr;
    min-height: calc(100vh - 108px);
  }
  aside {
    padding: 24px;
    border-right: 1px solid #334155;
  }
  p {
    font-size: 13px;
    line-height: 1.8;
    color: #b5c5d8;
  }
  button,
  .file {
    display: block;
    width: 100%;
    text-align: left;
    padding: 12px;
    margin: 12px 0;
    border: 1px solid #475569;
    background: #1e293b;
    color: #e2e8f0;
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .active {
    border-color: #2dd4bf;
    color: #5eead4;
  }
  .file input {
    display: block;
    width: 100%;
    margin-top: 10px;
    font-size: 11px;
  }
  hr {
    border: 0;
    border-top: 1px solid #334155;
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
    color: #94a3b8;
  }
  .canvas {
    aspect-ratio: 16/9;
    border: 1px solid #334155;
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
      border-bottom: 1px solid #334155;
    }
    header {
      padding: 20px;
      gap: 16px;
      flex-wrap: wrap;
    }
    .badge {
      white-space: nowrap;
    }
  }
</style>
