// The `scada:recording` events of a subscription (product-owner design C5
// §7.2): `frames` carries a delivery's state and control frames under the
// session generation (`seq`) that attached it; `ended` says nothing more
// follows. Both carry the root's `ownerEpoch`, since subscription references
// restart with each root.
export const RECORDING_EVENT = "scada:recording";

export type RecordingListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

export type RecordingEventPayload = Readonly<
  | {
      kind: "frames";
      subscriptionRef: string;
      ownerEpoch: string;
      seq: number;
      state: unknown;
      control: unknown;
    }
  | {
      kind: "ended";
      subscriptionRef: string;
      ownerEpoch: string;
      reason: string;
    }
>;

const own = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

/** The event, or `null` when it is not one the host sends. Frames stay unparsed. */
export function parseRecordingEvent(
  payload: unknown,
): RecordingEventPayload | null {
  const kind = own(payload, "kind"),
    subscriptionRef = own(payload, "subscriptionRef"),
    ownerEpoch = own(payload, "ownerEpoch");
  if (typeof subscriptionRef !== "string" || typeof ownerEpoch !== "string")
    return null;
  if (kind === "ended") {
    const reason = own(payload, "reason");
    return typeof reason === "string"
      ? Object.freeze({ kind, subscriptionRef, ownerEpoch, reason })
      : null;
  }
  if (kind !== "frames") return null;
  const seq = own(payload, "seq"),
    state = own(payload, "state") ?? null,
    control = own(payload, "control") ?? null;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0)
    return null;
  if (state === null && control === null) return null;
  return Object.freeze({
    kind,
    subscriptionRef,
    ownerEpoch,
    seq,
    state,
    control,
  });
}

/** Listens before anything is attached; the handler sees parsed events only. */
export function listenRecording(
  listen: RecordingListen,
  handler: (event: RecordingEventPayload) => void,
): Promise<() => void> {
  return listen<unknown>(RECORDING_EVENT, ({ payload }) => {
    const event = parseRecordingEvent(payload);
    if (event) handler(event);
  });
}
