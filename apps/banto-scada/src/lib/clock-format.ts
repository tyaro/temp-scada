import type { ClockShape } from "./project";

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** 端末のローカル時刻の日付を YYYY/MM/DD で返す。 */
function formatDate(date: Date): string {
  return `${pad(date.getFullYear(), 4)}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** 端末のローカル時刻を 24 時間の HH:mm（seconds が true なら HH:mm:ss）で返す。 */
function formatTime(date: Date, seconds: boolean): string {
  const base = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return seconds ? `${base}:${pad(date.getSeconds())}` : base;
}

/**
 * 時計の表示文字。時刻は Date か epoch ms で受け、端末のローカル時刻で書式にする
 * （試験では TZ に依存しないよう、ローカル時刻の Date を渡す）。
 * `seconds` は時刻の部分にだけ効き、日付だけの書式では無視する。
 */
export function formatClock(
  shape: Pick<ClockShape, "format" | "seconds">,
  at: Date | number,
): string {
  const date = typeof at === "number" ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return "";
  const seconds = shape.seconds === true;
  if (shape.format === "date") return formatDate(date);
  if (shape.format === "time") return formatTime(date, seconds);
  return `${formatDate(date)} ${formatTime(date, seconds)}`;
}

export const CLOCK_FORMATS = ["date", "time", "dateTime"] as const;
export const CLOCK_FORMAT_LABELS: Record<ClockShape["format"], string> = {
  date: "日付",
  time: "時刻",
  dateTime: "日付と時刻",
};

/** 保存の形を検査する（schema・Rust と同じ規則）。 */
export function validateClockShape(shape: ClockShape) {
  if (!(CLOCK_FORMATS as readonly string[]).includes(shape.format))
    throw new Error("時計の書式は日付・時刻・日付と時刻から選んでください");
  if (shape.seconds !== undefined && shape.seconds !== true)
    throw new Error("時計の秒の表示は true のときだけ保存します");
  const { fontSize, fontWeight, align } = shape.style;
  if (!(fontSize > 0 && fontSize <= 512))
    throw new Error("時計の文字サイズは0より大きく512以下にしてください");
  if (fontWeight !== "normal" && fontWeight !== "bold")
    throw new Error("時計の文字の太さが正しくありません");
  if (align !== "left" && align !== "center" && align !== "right")
    throw new Error("時計の文字揃えが正しくありません");
}
