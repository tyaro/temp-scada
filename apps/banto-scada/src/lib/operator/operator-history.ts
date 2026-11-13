/**
 * 運転表示の画面の履歴（戻る・進む）。純関数。仕様: docs/design/graphics/operator-frame.md
 * Designer の画面タブ・選択とは別に、運転表示だけが持つ。
 */

export const OPERATOR_HISTORY_LIMIT = 50;

export interface OperatorHistory {
  /** 古い順の画面 id。`index` が現在の画面。 */
  readonly entries: readonly string[];
  readonly index: number;
}

export function startHistory(screenId: string): OperatorHistory {
  return { entries: [screenId], index: 0 };
}

export function currentScreen(history: OperatorHistory): string {
  return history.entries[history.index];
}

export function canGoBack(history: OperatorHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: OperatorHistory): boolean {
  return history.index < history.entries.length - 1;
}

/**
 * 画面へ移る。現在の画面と同じなら変えない。進む側の履歴は捨て、上限を超えたら古い方から落とす。
 */
export function pushScreen(
  history: OperatorHistory,
  screenId: string,
  limit = OPERATOR_HISTORY_LIMIT,
): OperatorHistory {
  if (currentScreen(history) === screenId) return history;
  const entries = [...history.entries.slice(0, history.index + 1), screenId];
  const kept = entries.slice(Math.max(0, entries.length - limit));
  return { entries: kept, index: kept.length - 1 };
}

/** 1つ戻る。戻れないときは変えない。 */
export function goBack(history: OperatorHistory): OperatorHistory {
  return canGoBack(history)
    ? { entries: history.entries, index: history.index - 1 }
    : history;
}

/** 1つ進む。進めないときは変えない。 */
export function goForward(history: OperatorHistory): OperatorHistory {
  return canGoForward(history)
    ? { entries: history.entries, index: history.index + 1 }
    : history;
}
