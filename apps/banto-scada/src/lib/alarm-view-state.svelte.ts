import type { AlarmSnapshot } from "./alarm-mirror";
import type { AlarmDefinition } from "./alarms";
import { alarmConditionView, type AlarmView } from "./alarm-view";
import { alarmBannerView, type AlarmBannerView } from "./alarm-banner";
import { alarmValueColor, type AlarmValueColor } from "./alarm-value-color";

/**
 * 画面全体で使う警報の現在の状態（時計の clock-ticker と同じくモジュールの $state で配る）。
 * App が snapshot と編集中の Project を書き、小札は編集・プレビュー・運転表示のどこで
 * 描いても同じ状態を読む。仕様: docs/design/graphics/alarm-badge.md
 */
// 書く関数は読まない（App の $effect が書くので、読み書きが同じ effect に入らないようにする）。
let snapshot = $state.raw<AlarmSnapshot | null>(null);
let projectId = $state.raw<string | null>(null);
let blinkUnacked = $state.raw(false);
let definitions = $state.raw<readonly AlarmDefinition[]>([]);

export function setAlarmViewSnapshot(next: AlarmSnapshot | null): void {
  snapshot = next;
}

export function setAlarmViewProject(project: {
  manifest: { projectId: string };
  alarms?: { blinkUnacked?: boolean; definitions: readonly AlarmDefinition[] };
}): void {
  projectId = project.manifest.projectId;
  blinkUnacked = project.alarms?.blinkUnacked === true;
  definitions = project.alarms?.definitions ?? [];
}

/** condition の表示状態。$derived・テンプレートの中で読むと snapshot の更新で再評価される。 */
export function alarmViewOf(conditionId: string): AlarmView {
  return alarmConditionView(snapshot, projectId ?? "", conditionId);
}

/** 最新の警報の帯の表示。仕様: docs/design/graphics/alarm-banner.md */
export function alarmBannerViewOf(): AlarmBannerView {
  return alarmBannerView(snapshot, projectId ?? "");
}

export function alarmViewBlink(): boolean {
  return blinkUnacked;
}

export function alarmViewDefinitions(): readonly AlarmDefinition[] {
  return definitions;
}

/**
 * 数値の Text が指す警報の定義の状態（`alarmColor`）。定義が無ければ undefined。
 * 仕様: docs/design/graphics/alarm-value-color.md
 */
export function alarmValueColorOf(
  alarmId: string,
): AlarmValueColor | undefined {
  const definition = definitions.find((item) => item.id === alarmId);
  return definition
    ? alarmValueColor(definition, snapshot, projectId ?? "", blinkUnacked)
    : undefined;
}
