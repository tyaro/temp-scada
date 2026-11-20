import { tick } from "svelte";
import { alarmSettingsEntryReason } from "../../alarm-settings";
import { operatorStartScreen } from "../../operator/operator-layout";
import type { OperatorFrame } from "../../project";

/**
 * 運転表示・警報一覧・端末設定の窓（R7e1）。開閉の状態と、閉じたときに
 * フォーカスを戻す先（開いた要素）を持つ。表示確認・Project の世代・警報の
 * 供給元は App が持ち、host から受け取る。閉じる `$effect` と起動時の `onMount`
 * は App に残し、ここのメソッドを呼ぶ。
 */
export interface RuntimeWindowsHost {
  readonly mode: "edit" | "preview";
  readonly workspaceGeneration: number;
  readonly operatorFrame: OperatorFrame | undefined;
  readonly screens: readonly { id: string }[];
  /** Designer で表示中の画面 ID（運転表示の開始画面の候補）。 */
  readonly screenId: string;
  /** 端末設定を使えるかの判定に使う（`alarmSettingsEntryReason`）。 */
  readonly alarmFeed: { readonly alarmSettings?: unknown } | undefined;
  report(kind: "error", text: string): void;
}

export function createRuntimeWindowsController(host: RuntimeWindowsHost) {
  // 運転表示（プレビューの入口から開く）。開いている間は開始画面の id を持つ。
  let operatorStart = $state<string | null>(null);
  let operatorEntryButton = $state<HTMLButtonElement>();
  let operatorGeneration = 0;
  // Alarm list (alarm design §7): opened from the preview and the operator view.
  let alarmListOpen = $state(false);
  let alarmListOpener: Element | null = null;
  // Terminal settings (terminal settings design §7): the File menu and the
  // alarm list window. Not a Project setting; the browser has no host.
  let alarmSettingsOpen = $state(false);
  let alarmSettingsOpener: Element | null = null;
  const alarmSettingsReason = $derived(
    alarmSettingsEntryReason(host.alarmFeed),
  );

  function openOperatorView() {
    const start = operatorStartScreen(
      host.operatorFrame,
      host.screens,
      host.screenId,
    );
    if (!start) {
      host.report(
        "error",
        "運転表示を開けません。ヘッダー・フッター以外の画面を追加してください。",
      );
      return;
    }
    operatorGeneration = host.workspaceGeneration;
    operatorStart = start;
  }
  function closeOperatorView() {
    if (operatorStart === null) return;
    operatorStart = null;
    void tick().then(() => operatorEntryButton?.focus());
  }
  // 表示確認を離れたとき・Project を差し替えたときは閉じる（App の `$effect` から呼ぶ）。
  function closeStaleOperatorView() {
    if (
      operatorStart !== null &&
      (host.mode !== "preview" ||
        host.workspaceGeneration !== operatorGeneration)
    )
      operatorStart = null;
  }

  function openAlarmList() {
    if (host.mode !== "preview" || alarmListOpen) return;
    alarmListOpener = document.activeElement;
    alarmListOpen = true;
  }
  function closeAlarmList() {
    alarmListOpen = false;
  }
  // preview を離れたら閉じる（App の `$effect` から呼ぶ）。
  function closeAlarmListOutsidePreview() {
    if (alarmListOpen && host.mode !== "preview") alarmListOpen = false;
  }
  // 閉じたときのフォーカスの戻り先を一度だけ渡す（受け取ったら空にする）。
  function takeAlarmListOpener() {
    const opener = alarmListOpener;
    alarmListOpener = null;
    return opener;
  }

  function openAlarmSettings() {
    if (alarmSettingsOpen || alarmSettingsReason) return;
    alarmSettingsOpener = document.activeElement;
    alarmSettingsOpen = true;
  }
  function closeAlarmSettings() {
    alarmSettingsOpen = false;
  }
  // 閉じたときのフォーカスの戻り先を一度だけ渡す（受け取ったら空にする）。
  function takeAlarmSettingsOpener() {
    const opener = alarmSettingsOpener;
    alarmSettingsOpener = null;
    return opener;
  }

  return {
    get operatorStart() {
      return operatorStart;
    },
    // markup の `bind:this` が書き込む。
    get operatorEntryButton() {
      return operatorEntryButton;
    },
    set operatorEntryButton(value: HTMLButtonElement | undefined) {
      operatorEntryButton = value;
    },
    get alarmListOpen() {
      return alarmListOpen;
    },
    get alarmSettingsOpen() {
      return alarmSettingsOpen;
    },
    get alarmSettingsReason() {
      return alarmSettingsReason;
    },
    openOperatorView,
    closeOperatorView,
    closeStaleOperatorView,
    openAlarmList,
    closeAlarmList,
    closeAlarmListOutsidePreview,
    takeAlarmListOpener,
    openAlarmSettings,
    closeAlarmSettings,
    takeAlarmSettingsOpener,
  };
}
