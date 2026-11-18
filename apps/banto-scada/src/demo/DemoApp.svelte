<script lang="ts">
  import { StatusBadge } from "@banto/ui";
  import App from "../App.svelte";
  import type { Project } from "../lib/project";
  import { createDemoAlarmFeed } from "./alarm-feed";
  import { createDemoHistoryService } from "./history-service";
  import { createDemoReadSource } from "./read-source";
  import type { DemoView } from "./registry";
  import type { DemoClock, DemoScenario } from "./scenario";

  // Pages のデモの入口。製品の App に、模擬値の読取・警報・履歴を props で渡す。
  let {
    title,
    project,
    scenario,
    clock,
    view,
  }: {
    title: string;
    project: Project;
    scenario: DemoScenario;
    clock: DemoClock;
    view: DemoView;
  } = $props();
  // svelte-ignore state_referenced_locally
  const readSource = createDemoReadSource(scenario, clock);
  // svelte-ignore state_referenced_locally
  const alarmFeed = createDemoAlarmFeed(project, scenario, clock);
  // 系列一覧は Project の版に結び付くので、編集のたびに作り直す。
  // svelte-ignore state_referenced_locally
  let current = $state.raw(project);
  const historyService = $derived(
    createDemoHistoryService(current, scenario, clock),
  );
</script>

{#snippet demoStatus()}
  <span class="demo-status" data-demo-status>
    <StatusBadge variant="warning" label="デモ（模擬値）" />
    <a href="./index.html" title="デモのトップページへ戻る">デモ一覧</a>
  </span>
{/snippet}

<App
  {readSource}
  {alarmFeed}
  {historyService}
  startup={{ project, view }}
  headerExtension={demoStatus}
  connectionStatus={demoStatus}
  onprojectchange={(next) => (current = next)}
/>
<!-- 運転表示ではヘッダー（上の表示）が隠れるので、その間だけ出す注記。操作は通す。 -->
<p class="demo-note" data-demo-note>
  デモ（模擬値）・{title}・実設備には接続していません
</p>

<style>
  .demo-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
  }
  .demo-status a {
    color: var(--banto-primary);
    font-size: 12px;
  }
  .demo-note {
    display: none;
    position: fixed;
    right: 12px;
    bottom: 8px;
    z-index: 2147483000;
    margin: 0;
    padding: 2px 10px;
    border: 1px solid #b45309;
    border-radius: 999px;
    background: #fef3c7;
    color: #78350f;
    font-size: 12px;
    line-height: 1.6;
    pointer-events: none;
    opacity: 0.92;
  }
  :global(body:has([data-operator-screen])) .demo-note {
    display: block;
  }
</style>
