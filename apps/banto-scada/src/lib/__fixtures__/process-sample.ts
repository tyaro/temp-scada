import sample from "../../../../../examples/process.project.json";

/**
 * 工程図サンプルから運転表示の枠（`operatorFrame` とヘッダー・フッターの画面）を除いたもの。
 * 画面が1つであることを前提にした画面・Symbol の試験で使う。
 */
export function processSampleWithoutFrame(): typeof sample {
  const frame = sample.operatorFrame;
  const framed = new Set([frame.headerScreenId, frame.footerScreenId]);
  const { operatorFrame: _frame, ...rest } = structuredClone(sample);
  return {
    ...rest,
    screens: rest.screens.filter((screen) => !framed.has(screen.id)),
  } as typeof sample;
}
