import { expect, test, type Page } from "@playwright/test";
import sample from "../examples/minimal.project.json" with { type: "json" };
import fixtures from "../examples/recording-operations-cases.json" with { type: "json" };
import { chooseMenuItem } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

// The desktop's asynchronous recording operations over a mocked Tauri IPC
// (product-owner design C5 §7.2): NativeShell reads `recording_slot`, the
// native port attaches with `recording_attach` and receives
// `scada:recording` events, and each stage goes to its registry command.
// The mocked registry is the controlled port harness behind the Tauri
// command and event shapes (`__fixtures__/recording-native-host.ts`); the
// App, workspace, coordinator, port, ledger and receiver are production.
const project = {
  ...sample,
  recordingPlan: fixtures.bases.change.apply.desired,
};
const file = () => ({
  name: "native-async.project.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(project)),
});

async function mockNativeHost(page: Page) {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let nextId = 0;
    const emit = (event: string, payload: unknown) => {
      for (const l of listeners.values())
        if (l.event === event)
          callbacks.get(l.handler)?.({ event, id: 1, payload });
    };
    // The calls of every page load, so a reload's calls can be told apart.
    const saved = sessionStorage.getItem("__recordingCalls");
    const calls: { page: number; cmd: string; args: any }[] = saved
      ? JSON.parse(saved)
      : [];
    const page = Number(sessionStorage.getItem("__recordingPage") ?? "0") + 1;
    sessionStorage.setItem("__recordingPage", String(page));
    let host: Promise<any> | undefined;
    const native = {
      calls,
      page,
      host: () =>
        (host ??= import(
          "/src/lib/__fixtures__/recording-native-host.ts" as string
        ).then((m) => {
          const h = m.createNativeRecordingHost(emit);
          // The owner outlives a page: the next page's host starts from the
          // earlier page's owner frame.
          const owner = sessionStorage.getItem("__recordingOwner");
          if (owner) h.patch(JSON.parse(owner));
          const held = sessionStorage.getItem("__recordingHeld");
          if (held) h.hold(JSON.parse(held));
          return h;
        })),
    };
    Object.assign(window, { __recordingNative: native });
    Object.assign(window, {
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener(_event: string, eventId: number) {
          listeners.delete(eventId);
        },
      },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
        transformCallback(callback: (event: unknown) => void) {
          const id = ++nextId;
          callbacks.set(id, callback);
          return id;
        },
        async invoke(command: string, args: Record<string, any> = {}) {
          if (
            command.startsWith("recording_") &&
            command !== "recording_context"
          ) {
            calls.push({ page, cmd: command, args });
            sessionStorage.setItem("__recordingCalls", JSON.stringify(calls));
            return (await native.host()).invoke(command, args);
          }
          switch (command) {
            case "plugin:event|listen": {
              const id = ++nextId;
              listeners.set(id, { event: args.event, handler: args.handler });
              return id;
            }
            case "plugin:event|unlisten":
            case "hub_saved_endpoint":
            case "history_context":
              return null;
            case "hub_connect":
              return { state: "offline", cause: "test" };
            case "auth_phase":
              return {
                phase: "initializing",
                authDisabled: true,
                hasAdmin: false,
              };
            case "auth_resolve":
              return {
                identity: { id: "local", name: "ローカル", role: "admin" },
                kind: "local",
                checked: 1,
                current: 1,
                stale: false,
              };
          }
          throw { kind: "invalidRequest" };
        },
      },
    });
  });
}

const dialog = (p: Page) =>
  p.getByRole("dialog", { name: "記録計画の操作", exact: true });
const button = (p: Page, name: string) =>
  dialog(p).getByRole("button", { name, exact: true });
async function open(p: Page) {
  await chooseMenuItem(p, "記録", "記録計画の操作");
  await expect(dialog(p)).toBeVisible();
}
const calls = (p: Page) =>
  p.evaluate(() =>
    (window as any).__recordingNative.calls.map((c: any) => ({ ...c })),
  ) as Promise<{ page: number; cmd: string; args: any }[]>;
const onHost = <T>(p: Page, fn: string, ...args: unknown[]) =>
  p.evaluate(
    async ({ fn, args }) => {
      const h = await (window as any).__recordingNative.host();
      return h[fn](...args);
    },
    { fn, args },
  ) as Promise<T>;
const attaches = async (p: Page) =>
  (await calls(p)).filter((c) => c.cmd === "recording_attach");

async function ready(p: Page) {
  await mockNativeHost(p);
  await p.goto("/");
  await openProject(p, file());
  // The slot is read and its root attached once the Project and session are known.
  await expect
    .poll(async () => (await attaches(p)).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await open(p);
  await expect(button(p, "新しい変更を検査")).toBeVisible();
}
async function preflight(p: Page) {
  await dialog(p).getByLabel("期待mapping版", { exact: true }).fill("1");
  await dialog(p).getByLabel("期待保持適用版", { exact: true }).fill("1");
  await button(p, "新しい変更を検査").click();
  await expect(
    dialog(p).locator("[data-recording-async-admission]"),
  ).toHaveAttribute("data-recording-async-admission", "accepted");
}

test("a reservation goes through pause/join and apply to reconcile, stage by stage", async ({
  page,
}) => {
  await ready(page);
  await preflight(page);
  await onHost(page, "finish", 0);
  await expect(button(page, "この元runを停止してjoin")).toBeEnabled();
  await button(page, "この元runを停止してjoin").click();
  await expect(button(page, "同候補を適用")).toBeDisabled();
  await onHost(page, "finish", 1);
  await expect(button(page, "同候補を適用")).toBeEnabled();
  await button(page, "同候補を適用").click();
  await expect(dialog(page)).toContainText("同じ変更候補の設定適用中です");
  await onHost(page, "finish", 2, "workerFailure");
  await expect(dialog(page)).toContainText("commit有無不明");
  await button(page, "元要求の結果を照会").click();
  await expect(dialog(page)).toContainText("元要求の結果照会中です");
  await onHost(page, "finishRead", 0);
  await expect(dialog(page)).toContainText("設定commit済み");

  const sent = (await calls(page)).filter((c) =>
    [
      "recording_workflow_reserve",
      "recording_workflow_lease",
      "recording_lease",
      "recording_admission",
    ].includes(c.cmd),
  );
  const operations = await onHost<any[]>(page, "operationIds");
  expect(
    sent.map((c) =>
      c.cmd === "recording_workflow_lease"
        ? [c.cmd, c.args.stage, c.args.operationId, c.args.request.role]
        : c.cmd === "recording_lease"
          ? [c.cmd, c.args.request.role]
          : c.cmd === "recording_admission"
            ? [c.cmd, c.args.request.action.kind]
            : [c.cmd],
    ),
  ).toEqual([
    ["recording_workflow_reserve"],
    ["recording_workflow_lease", "preflight", null, "mutation"],
    ["recording_admission", "preflight"],
    ["recording_workflow_lease", "pauseJoin", operations[1], "mutation"],
    ["recording_admission", "pauseJoin"],
    ["recording_workflow_lease", "apply", operations[2], "mutation"],
    ["recording_admission", "apply"],
    ["recording_lease", "reconciliation"],
    ["recording_admission", "reconcile"],
  ]);
  // Each accepted operation was observed by its own query.
  expect(
    (await calls(page)).filter((c) => c.cmd === "recording_observation").length,
  ).toBeGreaterThanOrEqual(4);
});

test("a second change on the same root is refused without hanging the panel", async ({
  page,
}) => {
  await ready(page);
  await preflight(page);
  await onHost(page, "finish", 0, "conflict");
  await expect(button(page, "新しい変更を検査")).toBeEnabled();
  for (let attempt = 0; attempt < 2; attempt++) {
    await button(page, "新しい変更を検査").click();
    await expect(dialog(page)).toContainText(
      "新しい変更を始めるには、記録を停止して再開してください",
    );
    await expect(
      dialog(page).locator("[data-recording-async-admission]"),
    ).toHaveAttribute("data-recording-async-admission", "idle");
    await expect(button(page, "新しい変更を検査")).toBeEnabled();
  }
  const admissions = (await calls(page)).filter(
    (c) => c.cmd === "recording_admission",
  );
  expect(admissions).toHaveLength(1);
});

test("a subscription ended unauthorized disables the operations and is not attached again", async ({
  page,
}) => {
  await ready(page);
  await expect(button(page, "新しい変更を検査")).toBeEnabled();
  await onHost(page, "end", "unauthorized");
  await expect(dialog(page)).toContainText(
    "記録操作の権限を確認できません。新しい操作はできません。",
  );
  await expect(button(page, "新しい変更を検査")).toBeDisabled();
  await page.waitForTimeout(500);
  expect(await attaches(page)).toHaveLength(1);
});

test("a reloaded page attaches anew, shows the earlier work and sends none of it again", async ({
  page,
}) => {
  await ready(page);
  await preflight(page);
  await onHost(page, "finish", 0);
  await expect(button(page, "この元runを停止してjoin")).toBeEnabled();
  const [before] = await attaches(page);
  await page.evaluate(async () => {
    const h = await (window as any).__recordingNative.host();
    const s = h.harness.frame.display.snapshot;
    sessionStorage.setItem(
      "__recordingOwner",
      JSON.stringify({ admission: s.admission, operation: s.operation }),
    );
  });
  await page.reload();
  await openProject(page, file());
  await expect
    .poll(
      async () => (await attaches(page)).filter((c) => c.page === 2).length,
      {
        timeout: 30_000,
      },
    )
    .toBe(1);
  const after = (await attaches(page)).find((c) => c.page === 2)!;
  expect(after.args.request.attachId).not.toBe(before.args.request.attachId);
  await open(page);
  await expect(dialog(page)).toContainText(
    "前の画面の作業が残っています。アプリを終了すると候補は破棄されます。",
  );
  await expect(button(page, "この元runを停止してjoin")).toBeDisabled();
  // Nothing of the earlier page is sent again.
  expect(
    (await calls(page))
      .filter((c) => c.page === 2)
      .map((c) => c.cmd)
      .filter(
        (cmd) =>
          cmd !== "recording_slot" &&
          cmd !== "recording_attach" &&
          cmd !== "recording_workflow_resumption",
      ),
  ).toEqual([]);
});

test("a reloaded page takes the Candidate over from the host and continues it", async ({
  page,
}) => {
  await ready(page);
  await preflight(page);
  await onHost(page, "finish", 0);
  await expect(button(page, "この元runを停止してjoin")).toBeEnabled();
  await page.evaluate(async () => {
    const h = await (window as any).__recordingNative.host();
    const s = h.harness.frame.display.snapshot;
    sessionStorage.setItem(
      "__recordingOwner",
      JSON.stringify({ admission: s.admission, operation: s.operation }),
    );
    sessionStorage.setItem(
      "__recordingHeld",
      JSON.stringify(await h.workflow()),
    );
  });
  await page.reload();
  await openProject(page, file());
  await expect
    .poll(
      async () => (await attaches(page)).filter((c) => c.page === 2).length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await open(page);
  await expect(dialog(page)).toContainText("前の画面の作業を引き継ぎました。");
  await expect(dialog(page)).not.toContainText("前の画面の作業が残っています");
  await expect(button(page, "この元runを停止してjoin")).toBeEnabled();
  const pageTwo = async () =>
    (await calls(page)).filter((c) => c.page === 2).map((c) => c);
  expect((await pageTwo()).map((c) => c.cmd)).not.toContain(
    "recording_admission",
  );

  await button(page, "この元runを停止してjoin").click();
  await expect
    .poll(
      async () =>
        (await pageTwo()).filter((c) => c.cmd === "recording_admission").length,
    )
    .toBe(1);
  const admitted = (await pageTwo()).find(
    (c) => c.cmd === "recording_admission",
  )!;
  const first = (await calls(page)).find(
    (c) => c.page === 1 && c.cmd === "recording_admission",
  )!;
  expect(admitted.args.request.action.kind).toBe("pauseJoin");
  expect(admitted.args.request.admissionId).not.toBe(
    first.args.request.admissionId,
  );
});

test("a reloaded page continues a reservation that has no admission with the same change", async ({
  page,
}) => {
  await ready(page);
  await preflight(page);
  const reserved = (await calls(page)).find(
    (c) => c.cmd === "recording_workflow_reserve",
  )!.args.request;
  await page.evaluate((change) => {
    sessionStorage.setItem(
      "__recordingHeld",
      JSON.stringify({
        resumption: { state: "held", change, admissions: [] },
        outcomes: [],
      }),
    );
  }, reserved);
  await page.reload();
  await openProject(page, file());
  await expect
    .poll(
      async () => (await attaches(page)).filter((c) => c.page === 2).length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await open(page);
  await expect(dialog(page)).toContainText(
    "前の画面で予約した変更があります。検査すると同じ変更で続けます。",
  );
  await button(page, "新しい変更を検査").click();
  await expect
    .poll(
      async () =>
        (await calls(page)).filter(
          (c) => c.page === 2 && c.cmd === "recording_workflow_reserve",
        ).length,
    )
    .toBe(1);
  const again = (await calls(page)).find(
    (c) => c.page === 2 && c.cmd === "recording_workflow_reserve",
  )!;
  expect(again.args.request).toEqual(reserved);
});

test("an empty slot reads as offline and the next root attaches by itself", async ({
  page,
}) => {
  await ready(page);
  await onHost(page, "setEmpty", "no_recording_run");
  await onHost(page, "replaceRoot");
  await expect(dialog(page)).toContainText("記録操作サービスは未接続です");
  await expect(dialog(page)).not.toContainText("以前の対象の操作を監視");
  await button(page, "閉じる").click();
  // Changing the Project and coming back reads the slot, now installed again.
  await openProject(page, {
    ...file(),
    buffer: Buffer.from(
      JSON.stringify({
        ...project,
        manifest: {
          ...project.manifest,
          projectRevision: project.manifest.projectRevision + 1,
        },
      }),
    ),
  });
  await onHost(page, "setEmpty", null);
  await openProject(page, file());
  await open(page);
  await expect(button(page, "新しい変更を検査")).toBeEnabled();
  await expect(dialog(page)).not.toContainText("以前の対象の操作を監視");
  await expect(button(page, "選択した接続へ切替")).toBeDisabled();
});

test("after ownerClosed the slot is read again and the new root is attached", async ({
  page,
}) => {
  await ready(page);
  const slots = (await calls(page)).filter(
    (c) => c.cmd === "recording_slot",
  ).length;
  await onHost(page, "replaceRoot");
  await expect
    .poll(
      async () => (await attaches(page)).at(-1)!.args.request.scope.ownerEpoch,
    )
    .toBe("epoch:2");
  expect(
    (await calls(page)).filter((c) => c.cmd === "recording_slot").length,
  ).toBeGreaterThan(slots);
  // The workspace keeps the closed owner on screen until the new one is
  // chosen explicitly.
  await expect(dialog(page)).toContainText(
    "記録操作の対象（owner）が終了しました。新しい操作はできません。",
  );
  await button(page, "選択した接続へ切替").click();
  await expect(button(page, "新しい変更を検査")).toBeEnabled();
  await preflight(page);
  const admission = (await calls(page))
    .filter((c) => c.cmd === "recording_admission")
    .at(-1)!;
  expect(admission.args.request.ownerRef).toBe("owner:async-test");
});
