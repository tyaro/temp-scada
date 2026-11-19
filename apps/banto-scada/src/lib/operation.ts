/**
 * 段階3の運転操作（docs/design/runtime/operation-stage3-design.md）の、
 * Runtime の小窓が使う純関数。書込みの可否と値の解決は host
 * （crates/scada-host/src/operation_write）が決める。ここはその規則を写し、
 * 送る前に同じ結果を画面に出すためだけに使う。
 */
import type { SlotType } from "./equipment";
import type { Project } from "./project";
import type { SlotPresentation } from "./slot-presentation";

/** 入力の文字列の上限（host `MAX_INPUT_CHARS`）。超えたら `invalid_request`。 */
export const MAX_INPUT_CHARS = 128;

export interface OperationButton {
  index: number;
  label: string;
  value: boolean | number;
}
/** 小窓の操作の行（§8）。`write` を持つ slot ごとに 1 行。 */
export interface OperationRow {
  slotName: string;
  slotType: SlotType;
  label: string;
  buttons: OperationButton[];
  input: { min: number; max: number } | null;
}

/** 機器の操作の行を、機器種別の slot の順に返す。機器・種別が無ければ空。 */
export function operationRows(
  project: Project,
  equipmentId: string,
): OperationRow[] {
  const equipment = project.equipment?.find((item) => item.id === equipmentId);
  const type = equipment
    ? project.equipmentTypes?.find((item) => item.id === equipment.typeId)
    : undefined;
  return (type?.slots ?? []).flatMap((slot) =>
    slot.write
      ? [
          {
            slotName: slot.name,
            slotType: slot.type,
            label: slot.write.label,
            buttons: (slot.write.buttons ?? []).map((button, index) => ({
              index,
              label: button.label,
              value: button.value,
            })),
            input: slot.write.input
              ? { min: slot.write.input.min, max: slot.write.input.max }
              : null,
          },
        ]
      : [],
  );
}

/**
 * 入力の小数桁の上限（host `slot_decimals`）。押した配置の Symbol の中で、
 * その slot を `slotBinding` で表示する文字・表のセルの `format.decimals`
 * の最大。表示が無ければ null（桁を制限しない）。
 */
export function inputDecimals(
  project: Project,
  screenId: string,
  objectId: string,
  slotName: string,
): number | null {
  const placement = project.screens
    .find((screen) => screen.id === screenId)
    ?.objects.find((object) => object.id === objectId);
  if (placement?.shape.type !== "symbol") return null;
  const symbolId = placement.shape.symbolId;
  const symbol = project.symbols.find((item) => item.id === symbolId);
  return symbol ? collectDecimals(symbol.objects, slotName, null) : null;
}

const U32_MAX = 4294967295;
function collectDecimals(
  value: unknown,
  slotName: string,
  found: number | null,
): number | null {
  if (Array.isArray(value))
    return value.reduce<number | null>(
      (acc, child) => collectDecimals(child, slotName, acc),
      found,
    );
  if (value === null || typeof value !== "object") return found;
  const map = value as Record<string, unknown>;
  const binding = map.slotBinding as { slotName?: unknown } | undefined;
  if (binding?.slotName === slotName) {
    const decimals = (map.format as { decimals?: unknown } | undefined)
      ?.decimals;
    if (
      typeof decimals === "number" &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= U32_MAX
    )
      found = found === null ? decimals : Math.max(found, decimals);
  }
  for (const child of Object.values(map))
    found = collectDecimals(child, slotName, found);
  return found;
}

export type OperationInputResult =
  | { ok: true; value: number; fractional: boolean }
  | { ok: false; reason: "invalid_value" | "out_of_range" | "invalid_request" };

const DECIMAL = /^-?([0-9]+)(?:\.([0-9]+))?$/;
/**
 * 入力の検査（host `check_shape` の文字数・`resolve` の入力・`parse_input`）。
 * 半角の 10 進（任意の `-`、整数部、任意の `.` と小数部）だけを受け、
 * `decimals` を超える小数桁は丸めずに `invalid_value`。`fractional` は
 * 入力のままの小数部に 0 でない桁があるか（整数タグは `type_mismatch`）。
 * 共通ケース: examples/operation-input-cases.json
 */
export function parseOperationInput(
  text: string,
  slotType: SlotType,
  decimals: number | null,
  range: { min: number; max: number } | null,
): OperationInputResult {
  if ([...text].length > MAX_INPUT_CHARS)
    return { ok: false, reason: "invalid_request" };
  if (slotType !== "number" || !range)
    return { ok: false, reason: "invalid_value" };
  const match = DECIMAL.exec(text);
  if (!match) return { ok: false, reason: "invalid_value" };
  const fraction = match[2] ?? "";
  if (decimals !== null && fraction.length > decimals)
    return { ok: false, reason: "invalid_value" };
  const value = Number(text);
  if (!Number.isFinite(value) || value < range.min || value > range.max)
    return { ok: false, reason: "out_of_range" };
  return {
    ok: true,
    value,
    fractional: /[1-9]/.test(fraction) || !Number.isInteger(value),
  };
}

/** ボタンか入力か。どちらか 1 つだけを送る。 */
export type OperationChoice = { buttonIndex: number } | { input: string };

/** host の `OperationWriteRequest`（camelCase、未知の項目は拒まれる）。 */
export type OperationWriteRequest = {
  projectId: string;
  projectDigest: string;
  screenId: string;
  objectId: string;
  equipmentId: string;
  slotName: string;
  expectedValue: boolean | number;
} & (
  | { buttonIndex: number; input?: never }
  | { input: string; buttonIndex?: never }
);

export function buildOperationRequest(target: {
  projectId: string;
  projectDigest: string;
  screenId: string;
  objectId: string;
  equipmentId: string;
  slotName: string;
  choice: OperationChoice;
  expectedValue: boolean | number;
}): OperationWriteRequest {
  const base = {
    projectId: target.projectId,
    projectDigest: target.projectDigest,
    screenId: target.screenId,
    objectId: target.objectId,
    equipmentId: target.equipmentId,
    slotName: target.slotName,
    expectedValue: target.expectedValue,
  };
  return "buttonIndex" in target.choice
    ? { ...base, buttonIndex: target.choice.buttonIndex }
    : { ...base, input: target.choice.input };
}

/** 確認の小窓（§8）の中身: 機器名・見出し・現在値→書く値・品質。 */
export interface ConfirmationContent {
  equipmentName: string;
  equipmentCode: string;
  label: string;
  /** Good の値の文字（SIM つき）。Good でなければ `--`。 */
  currentText: string;
  /** 品質の語（Good・不良・未接続など）。 */
  quality: string;
  /** ボタンは「見出し（値）」、入力は入力の文字列のまま。 */
  writeText: string;
}

export function confirmationContent(
  equipment: { name: string; code: string },
  row: OperationRow,
  current: SlotPresentation,
  choice: OperationChoice,
): ConfirmationContent {
  let writeText: string;
  if ("buttonIndex" in choice) {
    const button = row.buttons[choice.buttonIndex];
    writeText = button
      ? `${button.label}（${String(button.value)}）`
      : `ボタン ${choice.buttonIndex}`;
  } else writeText = choice.input;
  return {
    equipmentName: equipment.name,
    equipmentCode: equipment.code,
    label: row.label,
    currentText: current.state === "good" ? current.text : "--",
    quality: current.label,
    writeText,
  };
}

/** 記録の区分（host `Outcome`、§5）。 */
export type OperationOutcome =
  "ok" | "refused" | "not_sent" | "stopped" | "failed" | "uncertain";

const outcomeTexts: Record<OperationOutcome, string> = {
  ok: "書込みました",
  refused: "送っていません",
  not_sent: "書込み先へは送られていません",
  stopped: "この端末の書込みは停止中",
  failed: "書込みは成立していません",
  uncertain: "書けたか分かりません。現在値を確かめてください",
};
/** §5 の小窓の表示。知らない区分は結果不明として扱う（fail-closed）。 */
export function outcomeText(outcome: string): string {
  return Object.hasOwn(outcomeTexts, outcome)
    ? outcomeTexts[outcome as OperationOutcome]
    : outcomeTexts.uncertain;
}

/** host が送信中として持っている行（§8）。 */
export const SENDING_TEXT = "送信中";
/** 送信を終えて結果を記録できなかった行（§8）。 */
export const UNRECORDED_TEXT =
  "結果を記録できませんでした。現在値を確かめてください";

/**
 * 理由のコードの日本語（§5）。`refused` は §4 の語（host `reason`）、
 * 送った後は tagclient の `ErrorKind::as_str()`。
 */
const reasonTexts: Record<string, string> = {
  // §4（host `operation_write::reason`）
  invalid_request: "要求の形が正しくありません",
  not_runtime: "運転の画面（Runtime）ではありません",
  auth_unavailable: "認証の状態を読めません",
  phase_unavailable: "運用の段階を確かめられません",
  not_authorized: "操作の権限がありません",
  project_changed: "画面の定義が変わりました。小窓を開き直してください",
  unknown_equipment: "機器が見つかりません",
  unknown_slot: "項目が見つかりません",
  no_write_def: "この項目は書込みできません",
  invalid_button: "ボタンが見つかりません",
  invalid_value: "値の書き方が正しくありません",
  out_of_range: "値が範囲の外です",
  unbound: "タグが割り付けられていません",
  catalog_unavailable: "タグの一覧を取得できません",
  catalog_pending: "タグの一覧を更新中です",
  unresolved: "タグが見つかりません",
  tag_disabled: "タグが無効です",
  not_writable: "タグは書込みできません",
  type_mismatch: "タグの型と値が合いません",
  hub_unsupported: "Hub が書込みに対応していません",
  no_write_key: "書き用キーが登録されていません",
  busy: "別の書込みを送信中です",
  record_failed: "実行記録に書けません",
  invalid_operator: "利用者名を送れません",
  auth_changed: "利用者または権限が変わりました",
  phase_changed: "運用の段階が変わりました",
  // §7（O2c）
  hub_mismatch: "書き用キーが別の接続先のものです",
  write_stopped: "この端末の書込みは停止中です",
  key_invalid: "書き用キーが無効です",
  too_soon: "前の書込みから間がありません",
  // 送信のタスクの異常終了（host `operation_db::INTERRUPTED`）
  interrupted: "送信の処理が途中で止まりました",
  // tagclient `ErrorKind::as_str()`（catalog_unavailable・stopped は上と共用）
  invalid_secret: "キーの形式が正しくありません",
  invalid_endpoint: "接続先の設定が正しくありません",
  invalid_tag_selection: "タグの指定が正しくありません",
  duplicate_binding_key: "タグの指定が重複しています",
  duplicate_requested_external_name: "タグの指定が重複しています",
  duplicate_catalog_external_name: "Hub のタグ名が重複しています",
  binding_unresolved: "タグが見つかりません",
  unauthorized: "Hub がキーを認めませんでした",
  transport: "Hub と通信できません",
  protocol_error: "Hub の応答が正しくありません",
  revision_mismatch: "タグの一覧の版が合いません",
  runtime_metadata_mismatch: "Hub の情報が合いません",
  stopped: "Hub との接続が止まっています",
  write_forbidden: "Hub がこのタグへの書込みを許していません",
  write_unavailable: "Hub が書込みを受け付けられない状態です",
  write_rejected: "Hub が書込みを断りました",
  write_uncertain: "書込みの応答を受け取れませんでした",
  invalid_write_options: "書込みの指定が正しくありません",
  key_revoked: "キーが取り消されています",
  key_expired: "キーの期限が切れています",
  key_tripped: "Hub が書き用キーを止めました",
  key_not_found: "キーが見つかりません",
  credential_rejected: "Hub がキーを認めませんでした",
};
export function reasonText(code: string): string {
  return Object.hasOwn(reasonTexts, code)
    ? reasonTexts[code]
    : `不明な理由（${code}）`;
}

/** 記録の最後の 1 件（host の command `operation_view`）。 */
export interface OperationLatest {
  id: string;
  state: "finished" | "sending" | "unrecorded";
  outcome: OperationOutcome | null;
  reason: string | null;
  requestedAtMs: number;
  finishedAtMs: number | null;
  tag: string | null;
  value: unknown;
  /** Hub の監査行の id（Rust の `Option<i64>`）。成功で得られたときだけ。 */
  auditId: number | null;
}
export interface OperationView {
  /** 適用中の Project。無いときは null（`blocked` は `project_changed`）。 */
  projectId: string | null;
  projectDigest: string | null;
  /** 操作の行を押せなくする理由のコード。null は押せる。 */
  blocked: string | null;
  phase: string;
  slots: { slot: string; latest: OperationLatest | null }[];
}
