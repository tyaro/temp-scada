/**
 * A mocked desktop recording host for the IPC-mock e2e (product-owner design
 * C5 §7.2): the registry commands answer `{seq, reply}` and a subscription's
 * frames arrive as `scada:recording` events with the root's `ownerEpoch`.
 * The registry itself is the controlled port harness; only the Tauri
 * command and event shapes are added. Test/browser only.
 */
import {
  createAsyncPortHarness,
  type OwnerPatch,
} from "./recording-async-port";
import type { PortLeaseRequestV2 } from "../recording-async/port";

type Emit = (event: string, payload: unknown) => void;
type Harness = ReturnType<typeof createAsyncPortHarness>;

export function createNativeRecordingHost(emit: Emit) {
  const calls: { cmd: string; args: any }[] = [];
  let seq = 1;
  let generation = 0;
  let h!: Harness;
  let subscriptions = 0;
  let subscription: string | null = null;
  let unsubscribe = () => {};
  let empty: string | null = null;
  /** What the gate would hold: the earlier page's admissions and results. */
  let held: {
    resumption: unknown;
    outcomes: { target: unknown; outcome: unknown }[];
  } | null = null;

  function snapshot() {
    return h.frame.display.snapshot;
  }
  function install() {
    unsubscribe();
    generation++;
    subscriptions = 0;
    subscription = null;
    h = createAsyncPortHarness(undefined, {
      ownerEpoch: `epoch:${generation}`,
    });
    // Each change of the owner is one delivery to the live subscription.
    unsubscribe = h.port.subscribe(() => {
      if (!subscription) return;
      emit("scada:recording", {
        kind: "frames",
        subscriptionRef: subscription,
        ownerEpoch: h.scope.ownerEpoch,
        seq,
        state: {
          version: 1,
          kind: "recordingWireStateFrame",
          subscriptionRef: subscription,
          snapshot: snapshot(),
        },
        control: null,
      });
    });
  }
  install();
  const result = (reply: unknown) => ({ seq, reply });
  let reservedChange: string | undefined;
  const observation = async (request: any) => {
    const target = request.target;
    const all = [...h.operations, ...h.reads];
    const o = all.find(
      (x) => JSON.stringify(x.target) === JSON.stringify(target),
    );
    let outcome: unknown = { kind: "pending" };
    if (o?.settled) outcome = ((await o.promise) as any).outcome;
    const earlier = held?.outcomes.find(
      (x) => JSON.stringify(x.target) === JSON.stringify(target),
    );
    if (earlier) outcome = earlier.outcome;
    return {
      version: 1,
      kind: "recordingWireObservationReply",
      request,
      outcome,
    };
  };
  async function invoke(cmd: string, args: any = {}): Promise<unknown> {
    calls.push({ cmd, args: JSON.parse(JSON.stringify(args)) });
    if (cmd === "recording_slot")
      return empty
        ? { state: "empty", reason: empty }
        : { state: "installed", generation, scope: h.scope };
    if (empty) throw { kind: "recordingUnavailable", reason: empty };
    switch (cmd) {
      case "recording_workflow_reserve":
        // The registry holds one workflow per root and never releases it.
        reservedChange ??= args.request.changeId;
        if (args.request.changeId !== reservedChange) throw { kind: "busy" };
        return result({ changeId: args.request.changeId });
      case "recording_workflow_resumption":
        return result(held?.resumption ?? { state: "none" });
      case "recording_workflow_lease": {
        const request: PortLeaseRequestV2 =
          args.stage === "preflight" || args.stage === "discard"
            ? ({
                role: "mutation",
                stage: args.stage,
                change: null,
                lease: args.request,
              } as never)
            : {
                role: "mutation",
                stage: args.stage,
                operationId: args.operationId,
                lease: args.request,
              };
        return result(await h.impl.prepareLease(request).reply);
      }
      case "recording_lease":
        return result(
          await h.impl.prepareLease({
            role: "reconciliation",
            lease: args.request,
          }).reply,
        );
      case "recording_admission":
        return result(await h.impl.admit(args.request).reply);
      case "recording_admission_inspection":
        return result(await h.impl.inspectAdmission(args.request).reply);
      case "recording_cancel":
        return result(await h.impl.requestCancel(args.request).reply);
      case "recording_observation":
        return result(await observation(args.request));
      case "recording_call_inspection": {
        const found = h.admissions.find(
          (a) =>
            JSON.stringify(a.request) === JSON.stringify(args.request.original),
        );
        return result({
          version: 1,
          kind: "recordingWireCallInspectionReply",
          request: args.request,
          outcome: found?.accepted
            ? { kind: "terminal", reply: found.accepted }
            : { kind: "notFound" },
        });
      }
      case "recording_attach": {
        subscription = `native-subscription:${++subscriptions}`;
        return result({
          version: 1,
          kind: "recordingWireAttachReply",
          request: args.request,
          outcome: {
            kind: "attached",
            subscriptionRef: subscription,
            snapshot: snapshot(),
          },
        });
      }
      case "recording_control":
        return result({
          version: 1,
          kind: "recordingWireControlReply",
          request: args.request,
          outcome:
            args.request.action === "detach"
              ? { kind: "detached" }
              : { kind: "snapshot", snapshot: snapshot() },
        });
    }
    throw new Error(`Unexpected command: ${cmd}`);
  }
  return {
    invoke,
    calls,
    get harness() {
      return h;
    },
    get generation() {
      return generation;
    },
    get subscription() {
      return subscription;
    },
    patch(owner: Partial<OwnerPatch>) {
      h.emit(owner);
    },
    /** What the gate holds after this page: for the next page's host. */
    async workflow() {
      const admissions = h.admissions.filter((a) => a.accepted);
      const outcomes = [];
      for (const o of h.operations)
        if (o.settled)
          outcomes.push({
            target: o.target,
            outcome: ((await o.promise) as any).outcome,
          });
      return {
        resumption: {
          state: "held",
          change: (admissions[0]?.request.action as any)?.change,
          admissions: admissions.map((a) => ({
            request: a.request,
            reply: a.accepted,
          })),
        },
        outcomes,
      };
    },
    hold(next: typeof held) {
      held = next;
      // The host's operation references continue after the earlier page's.
      for (const o of next?.outcomes ?? [])
        h.operations.push({ target: o.target, settled: false } as never);
    },
    /** The operation ID of each accepted operation, in order. */
    operationIds: () => h.operations.map((o) => o.handle.request.operationId),
    finish: (index: number, kind?: string) => {
      h.finish(index, kind);
    },
    finishRead: (index: number, kind?: string) => {
      h.finishRead(index, kind);
    },
    /** The subscription ends with `reason` (a logout ends it `unauthorized`). */
    end(reason: string) {
      const ref = subscription;
      subscription = null;
      emit("scada:recording", {
        kind: "ended",
        subscriptionRef: ref,
        ownerEpoch: h.scope.ownerEpoch,
        reason,
      });
    },
    /** The root is taken out: `ownerClosed`, then a new root is installed. */
    replaceRoot() {
      const ref = subscription,
        old = h;
      subscription = null;
      emit("scada:recording", {
        kind: "frames",
        subscriptionRef: ref,
        ownerEpoch: old.scope.ownerEpoch,
        seq,
        state: {
          version: 1,
          kind: "recordingWireStateFrame",
          subscriptionRef: ref,
          snapshot: {
            ...old.frame.display.snapshot,
            revision: old.frame.display.snapshot!.revision + 1,
            closed: true,
          },
        },
        control: {
          version: 1,
          kind: "recordingWireControlFrame",
          scope: old.scope,
          subscriptionRef: ref,
          reason: "ownerClosed",
        },
      });
      install();
    },
    setEmpty(reason: string | null) {
      empty = reason;
    },
    setSeq(next: number) {
      seq = next;
    },
  };
}
