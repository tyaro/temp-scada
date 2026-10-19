// Run from the repository root: pnpm --filter banto-scada benchmark:editor
// Measures domain work in Node, not browser rendering or end-to-end input latency.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const sample = JSON.parse(
  readFileSync(
    new URL("../../../examples/minimal.project.json", import.meta.url),
  ),
);
const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(100, 1000, 5000);
assert(
  sizes.every((size) => Number.isInteger(size) && size >= 10 && size <= 10000),
);
assert(global.gc, "Use node --expose-gc to measure retained heap");
const server = await createServer({
  root,
  configFile: false,
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  logLevel: "error",
});

try {
  const { parseProject, serializeProject, referencedAssets } =
    await server.ssrLoadModule("/src/lib/project.ts");
  const { applyCommand } = await server.ssrLoadModule("/src/lib/editor.ts");
  const { recordEdit, emptyHistory, travelHistory, HISTORY_LIMIT } =
    await server.ssrLoadModule("/src/lib/history.ts");
  const { projectContent } = await server.ssrLoadModule(
    "/src/lib/save-state.ts",
  );

  const measure = (operation, repetitions = 9) => {
    // Warm each operation before sampling. GC is outside the timed interval.
    operation();
    const times = [];
    for (let i = 0; i < repetitions; i++) {
      global.gc();
      const start = performance.now();
      operation();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return {
      samples: times.length,
      medianMs: Number(times[Math.floor(times.length / 2)].toFixed(3)),
      maxMs: Number(times.at(-1).toFixed(3)),
    };
  };
  const results = [];
  for (const count of sizes) {
    const fixture = structuredClone(sample);
    fixture.screens = Array.from(
      { length: Math.ceil(count / 1000) },
      (_, screenIndex) => ({
        ...structuredClone(sample.screens[0]),
        id: `0199f002-0000-7000-8000-${(screenIndex + 1).toString(16).padStart(12, "0")}`,
        name: `Benchmark ${screenIndex + 1}`,
        objects: Array.from(
          { length: Math.min(1000, count - screenIndex * 1000) },
          (_, localIndex) => {
            const index = screenIndex * 1000 + localIndex;
            return {
              ...structuredClone(sample.screens[0].objects[index % 3]),
              id: `0199f001-0000-7000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
              order: localIndex,
            };
          },
        ),
      }),
    );
    const project = parseProject(JSON.stringify(fixture));
    const screenId = project.screens[0].id;
    const object = project.screens[0].objects[0];
    const command = {
      type: "update",
      screenId,
      objectId: object.id,
      patch: { x: object.x + 1 },
    };
    const moved = recordEdit(project, emptyHistory(), command, "edit");
    assert.equal(moved.project.screens[0].objects[0].x, object.x + 1);
    assert.equal(moved.history.past.length, 1);
    const restored = travelHistory(
      moved.project,
      moved.history,
      "undo",
      "edit",
    );
    assert.equal(projectContent(restored.project), projectContent(project));
    assert.equal(project.screens[0].objects[0].x, object.x);
    const json = serializeProject(project);
    const copy = parseProject(json);
    const timing = {
      edit: measure(() => applyCommand(project, command, "edit")),
      editWithHistory: measure(() =>
        recordEdit(project, emptyHistory(), command, "edit"),
      ),
      undo: measure(() =>
        travelHistory(moved.project, moved.history, "undo", "edit"),
      ),
      saveJson: measure(() => serializeProject(project)),
      // Isolated probes overlap with the operations above; do not sum them.
      parseAndValidate: measure(() => parseProject(json)),
      serializeAndValidate: measure(() => serializeProject(project)),
      cloneWithValidation: measure(() =>
        parseProject(serializeProject(project)),
      ),
      compareCanonicalPair: measure(
        () => projectContent(copy) === projectContent(project),
      ),
      collectAssetReferences: measure(() => referencedAssets(project)),
      historySnapshot: measure(() => serializeProject(project)),
    };
    global.gc();
    const before = process.memoryUsage();
    let state = { project, history: emptyHistory() };
    const commits = [];
    for (let index = 0; index < HISTORY_LIMIT; index++) {
      const start = performance.now();
      state = recordEdit(
        state.project,
        state.history,
        { type: "move-many", screenId, objectIds: [object.id], dx: 1, dy: 0 },
        "edit",
      );
      commits.push(performance.now() - start);
    }
    global.gc();
    const after = process.memoryUsage();
    assert.equal(state.history.past.length, HISTORY_LIMIT);
    assert.equal(
      state.project.screens[0].objects[0].x,
      object.x + HISTORY_LIMIT,
    );
    commits.sort((a, b) => a - b);
    results.push({
      objects: count,
      screens: project.screens.length,
      jsonBytes: Buffer.byteLength(json),
      timing,
      consecutiveMoveCommits: {
        count: commits.length,
        medianMs: Number(commits[Math.floor(commits.length / 2)].toFixed(3)),
        maxMs: Number(commits.at(-1).toFixed(3)),
      },
      retainedHistory: {
        snapshots: state.history.past.length,
        serializedUtf8Bytes: state.history.past.reduce(
          (sum, entry) => sum + Buffer.byteLength(entry),
          0,
        ),
        heapDeltaBytes: after.heapUsed - before.heapUsed,
        rssDeltaBytes: after.rss - before.rss,
      },
    });
    process.stderr.write(`Measured ${count} objects\n`);
  }
  process.stdout.write(
    JSON.stringify(
      {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        fixture:
          "Up to 1000 objects per screen, equal rectangle/ellipse/text mix, no assets or symbols",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await server.close();
}
