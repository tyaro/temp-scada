/** Browser display confirmation only. Does not implement deployment or operating-system kiosk. */
export interface FullscreenPort {
  supported(): boolean;
  isTarget(): boolean;
  hasFullscreen(): boolean;
  request(): Promise<void>;
  exit(): Promise<void>;
}
export interface PreviewFullscreenState {
  readonly supported: boolean;
  readonly active: boolean;
  readonly busy: boolean;
}
export function createPreviewFullscreen(
  port: FullscreenPort,
  changed: (state: PreviewFullscreenState) => void,
  error: (message: string) => void,
) {
  let scope: string | null = null,
    epoch = 0,
    owned = false,
    busy = false,
    disposed = false;
  const state = (): PreviewFullscreenState => ({
    supported: port.supported(),
    active: owned && port.isTarget(),
    busy,
  });
  const emit = () => {
    if (!disposed) changed(state());
  };
  function sync() {
    if (owned && !busy && !port.isTarget()) owned = false;
    emit();
  }
  async function leave() {
    if (busy) return;
    if (!owned || !port.isTarget()) {
      owned = false;
      emit();
      return;
    }
    busy = true;
    emit();
    try {
      await port.exit();
    } catch {
      if (!disposed)
        error("全画面を終了できません。ブラウザのEsc操作でも終了できます。");
    } finally {
      busy = false;
      if (!port.isTarget()) owned = false;
      emit();
    }
  }
  function setScope(next: string | null) {
    if (scope === next) return;
    scope = next;
    epoch++;
    if (owned && !busy) void leave();
  }
  async function toggle() {
    if (disposed || busy) return;
    if (owned && port.isTarget()) {
      await leave();
      return;
    }
    if (scope === null) return;
    if (!port.supported()) {
      error("このブラウザでは全画面表示を利用できません。");
      return;
    }
    if (port.hasFullscreen()) {
      error("別の全画面表示を終了してから操作してください。");
      return;
    }
    const ticket = epoch;
    owned = true;
    busy = true;
    emit();
    try {
      await port.request();
    } catch {
      owned = false;
      if (!disposed && ticket === epoch)
        error(
          "全画面に切り替えられません。ブラウザの許可や設定を確認してください。",
        );
    } finally {
      // Keep the request busy until stale cleanup finishes, preventing overlapping ownership.
      if ((disposed || ticket !== epoch) && owned && port.isTarget()) {
        try {
          await port.exit();
        } catch {
          if (!disposed)
            error(
              "全画面を終了できません。ブラウザのEsc操作で終了してください。",
            );
        }
      }
      busy = false;
      if (!port.isTarget()) owned = false;
      emit();
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    scope = null;
    epoch++;
    if (owned && !busy) void leave();
  }
  return { state, sync, setScope, toggle, dispose };
}
