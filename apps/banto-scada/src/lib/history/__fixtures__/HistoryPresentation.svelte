<script lang="ts">
  // Imported only by the e2e entry replacement. Normal App has no fixture hook.
  import { onMount } from "svelte";
  import rawCases from "../../../../../../examples/history-query-cases.json";
  import minmaxCases from "../../../../../../examples/history-minmax-cases.json";
  import retentionCases from "../../../../../../examples/history-retention-cases.json";
  import {
    parseHistoryContract,
    type HistoryQuery,
    type HistoryResult,
  } from "../../history-contract";
  import { setThemeMode } from "../../banto/setup";
  import {
    createHistoryController,
    HistorySourceError,
    type HistorySource,
  } from "../presentation";
  import TrendView from "../TrendView.svelte";
  let scenario = $state("raw");
  let count = $state(0);
  let calls = $state.raw<
    {
      value: HistoryResult;
      resolve(value: unknown): void;
      reject(error: unknown): void;
      settled: boolean;
    }[]
  >([]);
  function fixture(choice: string): HistoryResult {
    const original =
      choice === "minmax"
        ? minmaxCases[0].expected
        : choice === "mixed"
          ? minmaxCases[2].expected
          : choice === "expired"
            ? retentionCases[0].expected
            : rawCases[0].expected;
    const parsed = parseHistoryContract(original);
    if (parsed.kind !== "result") throw Error("fixture");
    if (choice === "extreme") {
      const series = parsed.series.find((row) => row.seriesId === "number")!;
      parsed.series = [series];
      parsed.query = {
        ...parsed.query,
        seriesIds: ["number"],
        fromMs: Number.MAX_SAFE_INTEGER - 1000,
        toMs: Number.MAX_SAFE_INTEGER,
      };
      const sample = series.raw.find((row) => row.value !== null)!;
      series.raw = [-Number.MAX_VALUE, Number.MAX_VALUE].map(
        (value, index) => ({
          ...sample,
          value,
          sampleTimeMs: parsed.query.fromMs + 100 + index * 100,
          ingestedAtMs: parsed.query.fromMs + 100 + index * 100,
          sourceTimeMs: 0,
          recordId: { sessionId: "extreme", sequence: index + 1 },
        }),
      );
      series.coverage = [
        {
          fromMs: parsed.query.fromMs,
          toMs: parsed.query.toMs,
          reason: "unknownCoverage",
        },
      ];
      series.watermark = null;
    }
    return parsed;
  }
  function makeSource(): HistorySource {
    return {
      query(query) {
        const value = fixture(query.requestId.split(":")[0]);
        value.query = structuredClone(query);
        count++;
        return new Promise((resolve, reject) => {
          calls = [
            ...calls.slice(-15),
            { value, resolve, reject, settled: false },
          ];
        });
      },
    };
  }
  const controller = createHistoryController(makeSource());
  let frame = $state.raw(controller.state);
  onMount(() => {
    const stop = controller.subscribe((next) => (frame = next));
    return () => {
      stop();
      controller.dispose();
    };
  });
  let sequence = 0;
  function load() {
    const query: HistoryQuery = fixture(scenario).query;
    query.requestId = `${scenario}:${++sequence}`;
    controller.load(query);
  }
  function reply(kind: "valid" | "invalid" | "limit") {
    const call = calls.find((row) => !row.settled);
    if (!call) return;
    call.settled = true;
    if (kind === "limit") call.reject(new HistorySourceError("tooManyPoints"));
    else if (kind === "invalid")
      call.resolve({
        ...call.value,
        query: { ...call.value.query, requestId: "wrong-request" },
      });
    else call.resolve(call.value);
  }
</script>

<main>
  <h1>履歴表示のローカル受入</h1>
  <p>サンプル応答のみ。SQLite・Hubには接続せず、Projectを変更しません。</p>
  <nav aria-label="受入fixture操作">
    <label
      >応答ケース <select bind:value={scenario} aria-label="応答ケース"
        ><option value="raw">raw</option><option value="minmax">minmax</option
        ><option value="mixed">混在</option><option value="expired"
          >保持期限経過</option
        ><option value="extreme">極端値</option></select
      ></label
    >
    <button onclick={load}>取得</button><button onclick={() => reply("valid")}
      >応答</button
    ><button onclick={() => reply("invalid")}>不正応答</button><button
      onclick={() => reply("limit")}>点数超過</button
    >
    <button onclick={() => controller.cancel()}>取消</button><button
      onclick={() => controller.setSource(undefined)}>切断</button
    ><button onclick={() => controller.setSource(makeSource())}>再接続</button>
    <button onclick={() => void setThemeMode("light")}>ライト</button><button
      onclick={() => void setThemeMode("dark")}>ダーク</button
    >
  </nav>
  <p data-fixture-count>source呼出 {count}件</p>
  <div class="trend-container"><TrendView state={frame} /></div>
</main>

<style>
  main {
    max-width: 1000px;
    margin: 24px auto;
    padding: 16px;
    color: var(--banto-text);
  }
  h1 {
    font-size: 20px;
  }
  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button,
  select {
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    padding: 6px 10px;
  }
</style>
