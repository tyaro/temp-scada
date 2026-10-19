import { expect, it, vi } from "vitest";
import {
  createPreviewFullscreen,
  type FullscreenPort,
} from "./preview-fullscreen";
function fixture() {
  let current = false,
    other = false,
    supported = true;
  const errors = vi.fn(),
    changed = vi.fn();
  const port: FullscreenPort = {
    supported: () => supported,
    isTarget: () => current,
    hasFullscreen: () => current || other,
    request: vi.fn(async () => {
      current = true;
    }),
    exit: vi.fn(async () => {
      current = false;
    }),
  };
  const controller = createPreviewFullscreen(port, changed, errors);
  return {
    port,
    controller,
    errors,
    changed,
    setCurrent: (v: boolean) => (current = v),
    setOther: (v: boolean) => (other = v),
    setSupported: (v: boolean) => (supported = v),
  };
}
it("only enters with a preview scope, exits its own full screen and observes native exit", async () => {
  const f = fixture();
  await f.controller.toggle();
  expect(f.port.request).not.toHaveBeenCalled();
  f.controller.setScope("preview:1");
  await f.controller.toggle();
  expect(f.controller.state()).toMatchObject({ active: true, busy: false });
  await f.controller.toggle();
  expect(f.port.exit).toHaveBeenCalledTimes(1);
  expect(f.controller.state().active).toBe(false);
  await f.controller.toggle();
  f.setCurrent(false);
  f.controller.sync();
  expect(f.controller.state().active).toBe(false);
  expect(f.errors).not.toHaveBeenCalled();
});
it("refuses unsupported and foreign fullscreen states without claiming or exiting them", async () => {
  const f = fixture();
  f.controller.setScope("preview:1");
  f.setSupported(false);
  await f.controller.toggle();
  expect(f.errors).toHaveBeenLastCalledWith(
    expect.stringContaining("利用できません"),
  );
  f.setSupported(true);
  f.setOther(true);
  await f.controller.toggle();
  expect(f.errors).toHaveBeenLastCalledWith(expect.stringContaining("別の"));
  f.controller.dispose();
  expect(f.port.exit).not.toHaveBeenCalled();
  expect(f.port.request).not.toHaveBeenCalled();
});
it("scope change exits the owned display while preserving the permission to retry an exit failure", async () => {
  const f = fixture();
  f.controller.setScope("preview:1");
  await f.controller.toggle();
  vi.mocked(f.port.exit).mockRejectedValueOnce(new Error("blocked"));
  f.controller.setScope(null);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.controller.state().active).toBe(true);
  await f.controller.toggle();
  expect(f.controller.state().active).toBe(false);
  expect(f.errors).toHaveBeenCalledTimes(1);
});
it("late request after scope roundtrip cleans up and blocks overlapping requests", async () => {
  const f = fixture();
  let resolve!: () => void;
  vi.mocked(f.port.request).mockImplementationOnce(
    () =>
      new Promise<void>(
        (r) =>
          (resolve = () => {
            f.setCurrent(true);
            r();
          }),
      ),
  );
  f.controller.setScope("preview:1");
  const pending = f.controller.toggle();
  f.controller.setScope(null);
  f.controller.setScope("preview:1");
  await f.controller.toggle();
  expect(f.port.request).toHaveBeenCalledTimes(1);
  resolve();
  await pending;
  expect(f.port.exit).toHaveBeenCalledTimes(1);
  expect(f.controller.state()).toMatchObject({ active: false, busy: false });
  await f.controller.toggle();
  expect(f.port.request).toHaveBeenCalledTimes(2);
});
it("dispose cleans up a late request and suppresses stale errors and state callbacks", async () => {
  const f = fixture();
  let resolve!: () => void;
  vi.mocked(f.port.request).mockImplementationOnce(
    () =>
      new Promise<void>(
        (r) =>
          (resolve = () => {
            f.setCurrent(true);
            r();
          }),
      ),
  );
  f.controller.setScope("preview:1");
  const pending = f.controller.toggle();
  f.controller.dispose();
  const notifications = f.changed.mock.calls.length;
  resolve();
  await pending;
  expect(f.port.exit).toHaveBeenCalledTimes(1);
  expect(f.changed).toHaveBeenCalledTimes(notifications);
  expect(f.errors).not.toHaveBeenCalled();
});
it("rejected request remains normal and can be retried", async () => {
  const f = fixture();
  f.controller.setScope("preview:1");
  vi.mocked(f.port.request).mockRejectedValueOnce(new Error("denied"));
  await f.controller.toggle();
  expect(f.controller.state()).toMatchObject({ active: false, busy: false });
  expect(f.errors).toHaveBeenCalledTimes(1);
  await f.controller.toggle();
  expect(f.controller.state().active).toBe(true);
});
