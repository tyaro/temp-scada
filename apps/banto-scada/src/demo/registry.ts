import { demoScenarioFrom, type DemoScenario } from "./scenario";

/** トップページと入口が共有する題材の一覧。題材を足すときはここへ 1 件加える。 */
export interface DemoSubject {
  /** URL の `?demo=` に使う名前。 */
  id: string;
  title: string;
  summary: string;
  /** 見せる表現（トップページの箇条書き）。 */
  highlights: string[];
  /** 筋書きの説明（トップページの 1 文）。 */
  story: string;
  project: () => Promise<unknown>;
  scenario: () => Promise<DemoScenario>;
}

export const DEMO_SUBJECTS: readonly DemoSubject[] = [
  {
    id: "water",
    title: "排水処理設備",
    summary:
      "原水槽から放流までの架空の排水処理ライン。全体フロー・原水ポンプ場・計測一覧の 3 画面を画面切替ボタンで移ります。",
    highlights: [
      "配管の矢印・分岐の点・交差のまたぎ",
      "槽の液位と、数値の書式（小数・単位）",
      "ポンプ・バルブ・ブロワーの状態色（運転・停止・故障）",
      "しきい値の警報の小札と、最新の警報の帯",
      "時計・表・履歴トレンド",
    ],
    story:
      "3 分で一巡します。流入が増えて原水槽の液位が上がり、予備ポンプが起動、上限の警報が出て、送水で液位が下がります。途中で予備ポンプが故障します。",
    project: async () =>
      (await import("../../../../examples/demo-water.project.json")).default,
    scenario: async () =>
      demoScenarioFrom(
        (await import("./scenarios/water.scenario.json")).default,
      ),
  },
];

export function findDemoSubject(id: string | null): DemoSubject | undefined {
  return DEMO_SUBJECTS.find((subject) => subject.id === id);
}

export type DemoView = "edit" | "preview" | "operator";
export function parseDemoView(value: string | null): DemoView {
  return value === "edit" || value === "preview" ? value : "operator";
}
/** `?at=` は筋書きを止める秒（0 以上、周期未満）。不正な値は使わない。 */
export function parseDemoAt(
  value: string | null,
  cycleSec: number,
): number | undefined {
  if (value === null || !/^\d+(\.\d+)?$/.test(value)) return undefined;
  const at = Number(value);
  return at < cycleSec ? at : undefined;
}
