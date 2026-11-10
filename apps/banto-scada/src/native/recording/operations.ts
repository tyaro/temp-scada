// The desktop's asynchronous recording operations (product-owner design C5
// §7.2): one port and coordinator per installed root (`recording_slot`'s
// generation), desktop session and Project, published as the App's
// `recordingAsyncOperations`. The slot is read at start, on a change of the
// session or the Project, when the port reports the owner closed, a new
// session generation (`seqChanged`) or a subscription given up (`stopped`),
// and after a recording management operation. There is no polling.
import {
  createAsyncRecordingOperationsCoordinator,
  type AsyncOperationsClient,
} from "../../lib/recording-async/coordinator";
import { readSlot, type RecordingInvoke } from "./commands";
import type { RecordingListen } from "./events";
import {
  createNativeRecordingPortV2,
  type NativePortOptions,
  type NativeRecordingPort,
  type PortSignal,
} from "./port";

/** Who is signed in: the part of the auth session the operations depend on. */
export interface OperationsAccess {
  readonly signedIn: boolean;
  /** An administrator (the synthetic one of the auth-disabled mode included). */
  readonly admin: boolean;
  /** Changes whenever the session changes. */
  readonly sessionKey: string;
}

export interface NativeRecordingOperations {
  /** The Project's ID and revision and the session; a change reads the slot. */
  update(projectKey: string, access: OperationsAccess): void;
  /** Read the slot again (after a recording management operation). */
  refresh(): void;
  dispose(): void;
}

type Live = {
  generation: number;
  port: NativeRecordingPort;
  close: () => void;
};

export function createNativeRecordingOperations(
  invoke: RecordingInvoke,
  listen: RecordingListen,
  publish: (client: AsyncOperationsClient | undefined) => void,
  portOptions: Partial<
    Pick<NativePortOptions, "setTimer" | "clearTimer" | "newId">
  > = {},
): NativeRecordingOperations {
  let key: string | undefined;
  let access: OperationsAccess | undefined;
  let live: Live | undefined;
  let reads = 0;
  let disposed = false;

  function retire() {
    const old = live;
    live = undefined;
    if (!old) return;
    // The closed coordinator keeps monitoring accepted work; the port stops
    // listening and attaching.
    old.close();
    old.port.dispose();
  }
  /** Reads the slot; `renew` makes a new port even for the same root. */
  function read(renew: boolean) {
    const issued = ++reads;
    const who = access;
    if (disposed || !who?.signedIn) return;
    void readSlot(invoke).then((slot) => {
      if (disposed || issued !== reads || who !== access) return;
      if (slot.state !== "installed") {
        if (live || slot.state === "empty") {
          retire();
          publish(undefined);
        }
        return;
      }
      if (live && live.generation === slot.generation && !renew) return;
      retire();
      let made: Live | undefined;
      const signal = (s: PortSignal) => {
        if (live !== made) return;
        read(s === "seqChanged");
      };
      try {
        const port = createNativeRecordingPortV2({
          ...portOptions,
          invoke,
          listen,
          scope: slot.scope,
          access: who.admin ? "mutation" : "read",
          signal,
        });
        const coordinator = createAsyncRecordingOperationsCoordinator(
          port.port,
        );
        made = live = {
          generation: slot.generation,
          port,
          close: coordinator.close,
        };
        publish(coordinator.client);
        void port.start();
      } catch {
        publish(undefined);
      }
    });
  }
  return {
    update(projectKey, next) {
      const k = JSON.stringify([
        projectKey,
        next.signedIn,
        next.admin,
        next.sessionKey,
      ]);
      if (disposed || k === key) return;
      key = k;
      access = next;
      retire();
      publish(undefined);
      read(true);
    },
    refresh() {
      read(false);
    },
    dispose() {
      disposed = true;
      reads++;
      retire();
    },
  };
}
