// Pure helpers for the history time inputs. Internal / IPC values stay UTC
// ("YYYY-MM-DDTHH:mm:ss.sssZ"); the local forms exist only for display and entry.
// Offsets are minutes EAST of UTC (JST = 540) so tests do not depend on the host TZ.

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Minutes east of UTC at the given instant, for the host's time zone. */
export function localOffsetMinutes(atMs: number): number {
  const offset = -new Date(atMs).getTimezoneOffset();
  return offset === 0 ? 0 : offset;
}

/** UTC ISO string -> "YYYY-MM-DDTHH:mm:ss" in the offset zone; "" when invalid. */
export function utcToLocalInput(iso: string, offsetMinutes: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const shifted = new Date(ms + offsetMinutes * 60_000);
  if (!Number.isFinite(shifted.getTime())) return "";
  return shifted.toISOString().slice(0, 19);
}

/** Local "YYYY-MM-DDTHH:mm[:ss]" in the offset zone -> UTC ISO string; undefined when invalid. */
export function localInputToUtc(
  value: string,
  offsetMinutes: number,
): string | undefined {
  const m = LOCAL_RE.exec(value);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(
    Number,
  );
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (
    !Number.isFinite(wall) ||
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi
  )
    return undefined;
  const utc = new Date(wall - offsetMinutes * 60_000);
  return Number.isFinite(utc.getTime()) ? utc.toISOString() : undefined;
}

/** "Last N ms" ending at nowMs (seconds-rounded so the display is tidy). */
export function recentRange(
  nowMs: number,
  durationMs: number,
): { from: string; to: string } {
  const to = Math.floor(nowMs / 1000) * 1000;
  return {
    from: new Date(to - durationMs).toISOString(),
    to: new Date(to).toISOString(),
  };
}

/** 3600000 -> "1時間", 600000 -> "10分", 90000 -> "1分30秒", 1500 -> "1.5秒". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "不明";
  if (ms === 0) return "0秒";
  if (ms < 1000) return `${ms}ミリ秒`;
  if (ms < 60_000 && ms % 1000 !== 0) return `${ms / 1000}秒`;
  const total = Math.floor(ms / 1000);
  const rest = ms - total * 1000;
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  return (
    `${h ? `${h}時間` : ""}${m ? `${m}分` : ""}${s ? `${s}秒` : ""}` +
    (rest ? `${rest}ミリ秒` : "")
  );
}

/** "+09:00" style label for the offset. */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const a = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
