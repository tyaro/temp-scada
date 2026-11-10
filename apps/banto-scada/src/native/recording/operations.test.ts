import { expect, it } from "vitest";
import {
  cloneDelivery as clone,
  deliveryFixtures,
} from "../../lib/__fixtures__/recording-wire-delivery-ledger-cases";
import {
  isAsyncOperationsClient,
  type AsyncOperationsClient,
} from "../../lib/recording-async/coordinator";
import { createNativeRecordingOperations } from "./operations";

const scope = clone(deliveryFixtures.scope);
const admin = { signedIn: true, admin: true, sessionKey: "admin" };

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function setup() {
  let slot: unknown = { state: "installed", generation: 1, scope };
  let seq = 1;
  const calls: { cmd: string; args: any }[] = [];
  const listeners = new Set<(e: { payload: unknown }) => void>();
  const invoke = async (cmd: string, args: any = {}) => {
    calls.push({ cmd, args });
    if (cmd === "recording_slot") return slot;
    if (cmd === "recording_attach")
      return {
        seq,
        reply: {
          version: 1,
          kind: "recordingWireAttachReply",
          request: args.request,
          outcome: {
            kind: "attached",
            subscriptionRef: "native-subscription:1",
            snapshot: {
              scope: args.request.scope,
              revision: 1,
              closed: false,
              ownerBlocked: false,
              admission: null,
              operation: null,
              reconciliation: null,
            },
          },
        },
      };
    if (cmd === "recording_control") throw { kind: "closed" };
    throw { kind: "invalidRequest" };
  };
  const listen = async (_: string, handler: any) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  };
  const published: (AsyncOperationsClient | undefined)[] = [];
  const ops = createNativeRecordingOperations(
    invoke,
    listen as never,
    (c) => published.push(c),
    {
      setTimer: () => 0,
      clearTimer: () => {},
    },
  );
  return {
    ops,
    calls,
    published,
    listeners,
    setSlot: (v: unknown) => (slot = v),
    setSeq: (n: number) => (seq = n),
    emit: (payload: unknown) => [...listeners].forEach((l) => l({ payload })),
    count: (cmd: string) => calls.filter((c) => c.cmd === cmd).length,
  };
}

it("publishes no client while signed out or while the slot is empty", async () => {
  const h = setup();
  h.ops.update("p:1", { signedIn: false, admin: false, sessionKey: "null" });
  await settle();
  expect(h.calls).toEqual([]);
  h.setSlot({ state: "empty", reason: "no_recording_run" });
  h.ops.update("p:1", admin);
  await settle();
  expect(h.count("recording_slot")).toBe(1);
  expect(h.count("recording_attach")).toBe(0);
  expect(h.published.at(-1)).toBeUndefined();
});

it("publishes a coordinator for the installed root and keeps it for the same generation", async () => {
  const h = setup();
  h.ops.update("p:1", admin);
  await settle();
  const client = h.published.at(-1);
  expect(isAsyncOperationsClient(client)).toBe(true);
  expect(client!.ownerRef).toBe(scope.ownerRef);
  expect(client!.current().owner).toMatchObject({
    access: "mutation",
    seq: 1,
    subscription: "attached",
  });
  h.ops.refresh();
  await settle();
  expect(h.count("recording_slot")).toBe(2);
  expect(h.published.at(-1)).toBe(client);
  // A Viewer gets a read port.
  h.ops.update("p:1", { signedIn: true, admin: false, sessionKey: "viewer" });
  await settle();
  expect(h.published.at(-1)!.current().owner.access).toBe("read");
});

it("reads the slot again when the owner closes, and attaches to the new root", async () => {
  const h = setup();
  h.ops.update("p:1", admin);
  await settle();
  const first = h.published.at(-1)!;
  const next = { ...scope, ownerEpoch: "epoch:2" };
  h.setSlot({ state: "installed", generation: 2, scope: next });
  h.emit({
    kind: "frames",
    subscriptionRef: "native-subscription:1",
    ownerEpoch: scope.ownerEpoch,
    seq: 1,
    state: null,
    control: {
      version: 1,
      kind: "recordingWireControlFrame",
      scope,
      subscriptionRef: "native-subscription:1",
      reason: "ownerClosed",
    },
  });
  await settle();
  expect(h.count("recording_slot")).toBe(2);
  const second = h.published.at(-1)!;
  expect(second).not.toBe(first);
  expect(first.current().closed).toBe(true);
  const attaches = h.calls.filter((c) => c.cmd === "recording_attach");
  expect(attaches.at(-1)!.args.request.scope.ownerEpoch).toBe("epoch:2");
  // The slot empties after the owner closes: no client.
  h.setSlot({ state: "empty", reason: "no_recording_run" });
  h.ops.refresh();
  await settle();
  expect(h.published.at(-1)).toBeUndefined();
});

it("makes a new port for the same root after a new session generation", async () => {
  const h = setup();
  h.ops.update("p:1", admin);
  await settle();
  const first = h.published.at(-1)!;
  h.setSeq(2);
  h.ops.refresh(); // same generation: kept
  await settle();
  expect(h.published.at(-1)).toBe(first);
  // A reply under another seq: the port says seqChanged, and a new port binds seq 2.
  h.emit({
    kind: "ended",
    subscriptionRef: "native-subscription:1",
    ownerEpoch: scope.ownerEpoch,
    reason: "invalidInput",
  });
  await settle();
  const second = h.published.at(-1)!;
  expect(second).not.toBe(first);
  expect(second.current().owner.seq).toBe(2);
});
