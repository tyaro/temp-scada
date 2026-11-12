<script lang="ts">
  import { untrack } from "svelte";
  import { data } from "./view";
  import type { Project } from "../project";
  import { parseRecordingOperationsContext } from "../recording-operations-contract";
  import type { RecordingOperationsService } from "./service";
  import type { AsyncOperationsClient } from "../recording-async/state";
  import { isAsyncOperationsClient } from "../recording-async/coordinator";
  import RecordingOperationsWorkspace from "./RecordingOperationsWorkspace.svelte";
  import type { ExpectedRevisions } from "../recording-management/expected";
  import AsyncRecordingOperationsWorkspace from "../recording-async/AsyncRecordingOperationsWorkspace.svelte";
  let {
    openOwner,
    project,
    generation,
    service,
    asyncClient,
    expectedRevisions,
    onclose,
  }: {
    openOwner: object | null;
    project: Project;
    generation: number;
    service?: RecordingOperationsService;
    asyncClient?: AsyncOperationsClient;
    /** The last recording management inspection's revisions (P1-7). */
    expectedRevisions?: ExpectedRevisions;
    onclose: () => void;
  } = $props();
  let mode = $state<"sync" | "async">(),
    heldSync = $state.raw<RecordingOperationsService>();
  function validSync(s: RecordingOperationsService | undefined) {
    if (!s) return false;
    try {
      parseRecordingOperationsContext(data(s, "context"));
      return [
        data(s, "preflight"),
        data(s, "pauseJoin"),
        data(s, "apply"),
        data(s, "discard"),
        data(s, "reconcile"),
        data(s, "current"),
        data(s, "subscribe"),
      ].every((m) => typeof m === "function");
    } catch {
      return false;
    }
  }
  const simultaneous = $derived(
    service !== undefined && asyncClient !== undefined,
  );
  const changedMode = $derived(
    (mode === "sync" && asyncClient !== undefined) ||
      (mode === "async" && service !== undefined),
  );
  const blocked = $derived(simultaneous || changedMode || mode === undefined);
  const conflict = $derived(
    simultaneous
      ? "同期・非同期サービスの設定が競合しています。新しい送信はできません。"
      : changedMode
        ? "このAppの操作モードは固定されています。以前の操作の監視を続けます。"
        : undefined,
  );
  $effect(() => {
    const s = service,
      a = asyncClient,
      both = simultaneous;
    untrack(() => {
      if (!mode && !both) {
        if (isAsyncOperationsClient(a)) mode = "async";
        else if (validSync(s)) mode = "sync";
      }
      if (mode === "sync" && s !== undefined) heldSync = s;
    });
  });
</script>

<!-- Both observers remain mounted. Only the fixed mode opens a dialog. -->
<RecordingOperationsWorkspace
  openOwner={mode !== "async" ? openOwner : null}
  {project}
  {generation}
  service={mode === "sync" ? (service ?? heldSync) : undefined}
  blocked={blocked || service === undefined}
  {conflict}
  {expectedRevisions}
  {onclose}
/>
<AsyncRecordingOperationsWorkspace
  openOwner={mode === "async" ? openOwner : null}
  {project}
  {generation}
  client={asyncClient}
  blocked={blocked || asyncClient === undefined}
  {conflict}
  {expectedRevisions}
  {onclose}
/>
