import { expect, it, vi } from "vitest";
import {
  CLOSE_EVENT,
  createCloseConfirmation,
  type ClosePrompt,
  type CloseView,
} from "./close";

function setup(reply: (args: Record<string, unknown>) => Promise<unknown>) {
  let handler: ((event: { payload: ClosePrompt }) => void) | undefined;
  const unlisten = vi.fn();
  const calls: Record<string, unknown>[] = [];
  const invoke = (command: string, args: Record<string, unknown> = {}) => {
    expect(command).toBe("app_close_reply");
    calls.push(args);
    return reply(args);
  };
  const listen = (async (event: string, h: typeof handler) => {
    expect(event).toBe(CLOSE_EVENT);
    handler = h;
    return unlisten;
  }) as Parameters<typeof createCloseConfirmation>[1];
  const views: CloseView[] = [];
  const confirmation = createCloseConfirmation(invoke, listen, (view) =>
    views.push(view),
  );
  return {
    confirmation,
    calls,
    views,
    unlisten,
    emit: async (payload: ClosePrompt) => {
      await vi.waitFor(() => expect(handler).toBeDefined());
      handler!({ payload });
    },
  };
}

it("acknowledges a question at once and answers it once", async () => {
  const t = setup(async () => null);
  await t.emit({ id: 3, kind: "candidate" });
  expect(t.views).toEqual([{ kind: "candidate", id: 3 }]);
  expect(t.calls).toEqual([{ id: 3, reply: "shown" }]);
  await t.confirmation.answer("discard");
  expect(t.views.at(-1)).toEqual({ kind: "discarding", id: 3 });
  expect(t.calls.at(-1)).toEqual({ id: 3, reply: "discard" });
  // Nothing more to answer.
  await t.confirmation.answer("cancel");
  expect(t.calls).toHaveLength(2);
});

it("closes the question on cancel", async () => {
  const t = setup(async () => null);
  await t.emit({ id: 1, kind: "candidate" });
  await t.confirmation.answer("cancel");
  expect(t.views.at(-1)).toBeUndefined();
  expect(t.calls.at(-1)).toEqual({ id: 1, reply: "cancel" });
});

it("shows the exit's wait without asking", async () => {
  const t = setup(async () => null);
  await t.emit({ id: 2, kind: "waiting" });
  expect(t.views).toEqual([{ kind: "waiting" }]);
  expect(t.calls).toEqual([]);
  await t.confirmation.answer("discard");
  expect(t.calls).toEqual([]);
});

it("drops the discarding notice when the host refuses a stale answer", async () => {
  const t = setup(async (args) => {
    if (args.reply === "discard") throw "stale_prompt";
    return null;
  });
  await t.emit({ id: 4, kind: "candidate" });
  await t.confirmation.answer("discard");
  expect(t.views.at(-1)).toBeUndefined();
});

it("keeps a newer discard's notice when an older answer is refused", async () => {
  let refuse: (reason: unknown) => void = () => {};
  const t = setup((args) =>
    args.id === 1 && args.reply === "discard"
      ? new Promise((_, reject) => (refuse = reject))
      : Promise.resolve(null),
  );
  await t.emit({ id: 1, kind: "candidate" });
  const older = t.confirmation.answer("discard");
  await t.emit({ id: 2, kind: "candidate" });
  await t.confirmation.answer("discard");
  refuse("stale_prompt");
  await older;
  expect(t.views.at(-1)).toEqual({ kind: "discarding", id: 2 });
});

it("ignores a payload that is not a close prompt", async () => {
  const t = setup(async () => null);
  await t.emit({ subscriptionId: "read" } as unknown as ClosePrompt);
  await t.emit({ kind: "candidate" } as unknown as ClosePrompt);
  expect(t.views).toEqual([]);
  expect(t.calls).toEqual([]);
});

it("stops listening when disposed", async () => {
  const t = setup(async () => null);
  await t.emit({ id: 5, kind: "candidate" });
  t.confirmation.dispose();
  expect(t.unlisten).toHaveBeenCalledOnce();
});
