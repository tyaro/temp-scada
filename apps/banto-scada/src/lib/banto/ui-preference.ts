import {
  createSavedSetting,
  type SavedSetting,
  type UiSettingsProvider,
} from "@banto/admin-core";

/**
 * UI の好み（パネルの幅・表示の有無・浮動配置など）1件を、上流の
 * `createSavedSetting`（tyaro/banto#437）に載せて保存する。
 *
 * 上流が持つもの: 送信は1件ずつ（送信中の保存は1回にまとめて後で送る）、
 * 保存済み（`saved`）は送信に成功した値だけ、古い読込みの答えは捨てる。
 * ここが持つもの: 通知の文言、壊れた値の解釈（`parse`）と既定値（`fallback`）。
 *
 * 保存の失敗は `current`（このタブで使う値）を残し、`saved` は前の値のまま。
 * まとめられた保存は同じ結果を共有するので、失敗の通知は失敗した送信ごとに1回。
 */
export interface UiPreferenceOptions<T> {
  provider: UiSettingsProvider;
  key: string;
  /** 壊れた値・知らない形式は `undefined`。 */
  parse: (raw: string) => T | undefined;
  serialize: (value: T) => string;
  fallback: () => T;
  warn: (message: string) => void;
  /** 保存に失敗したときの通知。`update` が `false` を返すときに出す。 */
  saveFailed: string;
  /** 読込みに失敗したとき（provider の失敗。壊れた値では出さない）。 */
  loadFailed: string;
}

export interface UiPreference<T> {
  /** このタブで使う値（保存に失敗しても残る）。 */
  readonly current: T;
  /** 最後に保存・読込みに成功した値。無ければ `undefined`。 */
  readonly saved: T | undefined;
  /** 値を変えて保存する。保存できたら `true`。失敗時は通知を出す。 */
  update(value: T): Promise<boolean>;
  /** 既定値に戻す（保存はしない。`save` で書く）。 */
  resetToDefault(): void;
  /** 今の値を保存する。失敗しても通知は出さない（呼び手がまとめて出す）。 */
  save(): Promise<boolean>;
  /** 保存値を読む。provider の失敗だけを通知する。 */
  load(): Promise<void>;
}

export function createUiPreference<T>(
  options: UiPreferenceOptions<T>,
): UiPreference<T> {
  const setting: SavedSetting<T> = createSavedSetting<T>({
    provider: options.provider,
    key: options.key,
    parse: options.parse,
    serialize: options.serialize,
    fallback: options.fallback,
    mode: "explicit",
  });
  // 上流はまとめた保存に同じ Promise を返す。通知は送信（Promise）ごとに1回。
  // `setting.error` は次の送信が結果を返す前に書き換えるので、見分けに使わない。
  const reported = new WeakSet<Promise<boolean>>();
  return {
    get current() {
      return setting.current;
    },
    get saved() {
      return setting.saved;
    },
    async update(value) {
      setting.set(value);
      const sending = setting.save();
      if (await sending) return true;
      if (!reported.has(sending)) {
        reported.add(sending);
        options.warn(options.saveFailed);
      }
      return false;
    },
    resetToDefault() {
      setting.resetToDefault();
    },
    save() {
      return setting.save();
    },
    async load() {
      if ((await setting.load()) === "failed") options.warn(options.loadFailed);
    },
  };
}
