import { expect, it } from "vitest";
import {
  cloneDelivery as clone,
  deliveryFixtures,
} from "../../lib/__fixtures__/recording-wire-delivery-ledger-cases";
import { callRecording, parseHostRefusal, readSlot } from "./commands";
import { parseRecordingEvent } from "./events";

const scope = clone(deliveryFixtures.scope);

it("classifies an answer as returned, a host refusal or a failure", async () => {
  const answer = (value: unknown, rejects = false) =>
    callRecording(
      async () => {
        if (rejects) throw value;
        return value;
      },
      "recording_cancel",
      {},
    );
  expect(await answer({ seq: 3, reply: { a: 1 } })).toEqual({
    kind: "returned",
    seq: 3,
    reply: { a: 1 },
  });
  for (const malformed of [
    null,
    { seq: -1, reply: 1 },
    { seq: 1.5, reply: 1 },
    { seq: 1 },
  ])
    expect(await answer(malformed)).toEqual({ kind: "failed" });
  expect(await answer({ kind: "busy" }, true)).toEqual({
    kind: "refused",
    refusal: { kind: "busy" },
  });
  expect(await answer(new Error("ipc"), true)).toEqual({ kind: "failed" });
  expect(
    parseHostRefusal({
      kind: "recordingUnavailable",
      reason: "no_recording_run",
    }),
  ).toEqual({
    kind: "recordingUnavailable",
    reason: "no_recording_run",
  });
  expect(parseHostRefusal({ kind: "phase", phase: "transitioning" })).toEqual({
    kind: "phase",
    phase: "transitioning",
  });
  expect(parseHostRefusal({ kind: "recordingUnavailable" })).toBe(null);
  expect(parseHostRefusal({ kind: "somethingElse" })).toBe(null);
});

it("reads the slot", async () => {
  const slot = (value: unknown) => readSlot(async () => value);
  expect(await slot({ state: "installed", generation: 2, scope })).toEqual({
    state: "installed",
    generation: 2,
    scope,
  });
  expect(await slot({ state: "empty", reason: "no_recording_run" })).toEqual({
    state: "empty",
    reason: "no_recording_run",
  });
  expect(await slot({ state: "installed", generation: 0, scope })).toEqual({
    state: "unknown",
  });
  expect(
    await slot({ state: "installed", generation: 1, scope: { ownerRef: "x" } }),
  ).toEqual({
    state: "unknown",
  });
  expect(
    await readSlot(async () => {
      throw { kind: "unauthorized" };
    }),
  ).toEqual({ state: "unknown" });
});

it("parses the events the host sends", () => {
  const base = {
    subscriptionRef: "native-subscription:1",
    ownerEpoch: "epoch:1",
  };
  expect(
    parseRecordingEvent({ kind: "ended", ...base, reason: "closed" }),
  ).toEqual({
    kind: "ended",
    ...base,
    reason: "closed",
  });
  expect(
    parseRecordingEvent({
      kind: "frames",
      ...base,
      seq: 1,
      state: { a: 1 },
      control: null,
    }),
  ).toMatchObject({
    kind: "frames",
    seq: 1,
    state: { a: 1 },
    control: null,
  });
  // No ownerEpoch (an older host), nothing to deliver, or not an event.
  expect(
    parseRecordingEvent({
      kind: "ended",
      subscriptionRef: "s",
      reason: "closed",
    }),
  ).toBe(null);
  expect(
    parseRecordingEvent({
      kind: "frames",
      ...base,
      seq: 1,
      state: null,
      control: null,
    }),
  ).toBe(null);
  expect(parseRecordingEvent("frames")).toBe(null);
});
