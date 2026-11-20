// フォームの種類（`data-editor-form`）ごとの編集コマンド生成と固有確定の登録表（R7a）。
// 各 adapter（./forms/*.ts）の解析・照合はそのまま呼ぶだけで、ここでは振分けしか持たない。
// 共通の edit／draft／history の境界（`submitForm`→`edit`、`validateDrafts`、
// `drafts.submitted`）は App に残す。App の状態はここへ移さず、呼ぶたびに
// `FormCommandContext` として App から受け取る。
import type { EditCommand } from "../editor";
import type { CatalogSelection } from "../catalog-session";
import type {
  GeometricGroup,
  Project,
  Screen,
  ScreenObject,
  SymbolDefinition,
} from "../project";
import { labelCanvasBackground } from "../shape-label";
import {
  symbolSlotFormCommand,
  acknowledgeSymbolSlotForm,
} from "./forms/symbol-slot";
import { equipmentTypeFormCommand } from "./forms/equipment-type";
import { equipmentFormCommand } from "./forms/equipment";
import { groupNameFormCommand } from "./forms/group-name";
import { lineConnectionCommand } from "./forms/line-connection";
import { imageFitCommand } from "./forms/image-fit";
import { imageCropCommand } from "./forms/image-crop";
import {
  selectionOutlineCommand,
  acknowledgeSelectionOutline,
} from "./forms/selection-outline";
import {
  selectionLineCommand,
  acknowledgeSelectionLine,
} from "./forms/selection-line";
import {
  selectionTextStyleCommand,
  acknowledgeSelectionTextStyle,
} from "./forms/selection-text-style";
import {
  selectionSizeCommand,
  acknowledgeSelectionSize,
} from "./forms/selection-size";
import {
  selectionOpacityCommand,
  acknowledgeSelectionOpacity,
} from "./forms/selection-opacity";
import {
  selectionPaintAlphaCommand,
  acknowledgeSelectionPaintAlpha,
} from "./forms/selection-paint-alpha";
import {
  selectionColorCommand,
  acknowledgeSelectionColor,
} from "./forms/selection-color";
import { stateColorCommand } from "./forms/state-color";
import { stateTextColorCommand } from "./forms/state-text-color";
import { numericFormatCommand } from "./forms/numeric-format";
import { boolDisplayCommand } from "./forms/bool-display";
import { alarmColorCommand } from "./forms/alarm-color";
import { symbolColorModeCommand } from "./forms/symbol-color-mode";
import { backgroundCropCommand } from "./forms/background-crop";
import { backgroundImageCommand } from "./forms/background-image";
import { objectFormCommand, acknowledgeObjectForm } from "./forms/object-form";
import { screenFormCommand } from "./forms/screen-form";
import { operatorFrameFormCommand } from "./forms/operator-frame-form";
import { alarmDefinitionFormCommand } from "./forms/alarm-definition-form";
import {
  projectFormCommand,
  acknowledgeProjectForm,
} from "./forms/project-form";
import { moveFormCommand } from "./forms/move-form";
import { shapePaintCommand } from "./forms/shape-paint";
import { shapeLabelCommand } from "./forms/shape-label";

/** 編集コマンドを作るフォームの種類。足したら `FORM_COMMANDS` に handler が要る。 */
export const COMMAND_FORM_KINDS = [
  "symbol-slot",
  "equipment-type",
  "equipment",
  "background-crop",
  "background-image",
  "line-connection",
  "image-fit",
  "image-crop",
  "shape-paint",
  "shape-label",
  "state-color",
  "numeric-format",
  "alarm-color",
  "bool-display",
  "state-text-color",
  "symbol-color-mode",
  "selection-outline",
  "selection-line",
  "selection-text-style",
  "selection-size",
  "selection-opacity",
  "selection-paint-alpha",
  "selection-color",
  "project",
  "operator-frame",
  "alarm-definition",
  "screen",
  "group-name",
  "move",
  "object",
] as const;

/**
 * draft としては数えるが、編集コマンドを作らないフォームの種類。
 *
 * `binding-replacement`（タグ参照名の一括置換）は自前の submit（差分の確認→明示適用）で
 * 確定し、`submitForm`→`formCommand` を通らない。保存・切替時の一括確定では
 * App の `validateDrafts` が `formCommand` より前にこの draft を拒否する。
 * そのため登録表には入れない（handler を書くと、通らない経路に見せかけの確定が生まれる）。
 * 万一 `formCommand` へ来た場合は、変更前と同じく通常配置のフォームへのフォールバックになる。
 */
export const DRAFT_ONLY_FORM_KINDS = ["binding-replacement"] as const;

/** `data-editor-form` に書いてよい種類の全部（単体試験で .svelte の記述と照合する）。 */
export const EDITOR_FORM_KINDS = [
  ...COMMAND_FORM_KINDS,
  ...DRAFT_ONLY_FORM_KINDS,
] as const;

export type CommandFormKind = (typeof COMMAND_FORM_KINDS)[number];
export type EditorFormKind = (typeof EDITOR_FORM_KINDS)[number];

/** handler が読む App の現在値。App が呼ぶたびに作って渡す（状態は App が持つ）。 */
export interface FormCommandContext {
  project: Project;
  screen: Screen | SymbolDefinition;
  activeDefinition: SymbolDefinition | undefined;
  workspaceGeneration: number;
  selectedIds: string[];
  selected: ScreenObject | undefined;
  backgroundScreen: Screen | undefined;
  activeGroup: GeometricGroup | undefined;
  catalogSelection: CatalogSelection;
}

export type FormCommandHandler = (
  form: HTMLFormElement,
  data: FormData,
  context: FormCommandContext,
) => EditCommand;

export type FormAcknowledgeHandler = (
  form: HTMLFormElement,
  context: FormCommandContext,
) => void;

/** フォームが指定の種類か。種類の綴りを型で検査するために使う。 */
export function isEditorForm(
  form: HTMLFormElement,
  kind: EditorFormKind,
): boolean {
  return form.dataset.editorForm === kind;
}

function isCommandFormKind(kind: string | undefined): kind is CommandFormKind {
  return (COMMAND_FORM_KINDS as readonly string[]).includes(kind ?? "");
}

const objectCommand: FormCommandHandler = (_form, data, c) =>
  objectFormCommand(data, {
    readSlots: ("readSlots" in c.screen ? c.screen.readSlots : []) ?? [],
    screenId: c.screen.id,
    definition: !!c.activeDefinition,
    selected: c.selected,
  });

const selectionTarget = (form: HTMLFormElement, data: FormData) => ({
  data,
  targetKey: form.dataset.targetKey,
  objectIds: form.dataset.objectIds,
});
const selectionContext = (c: FormCommandContext) => ({
  generation: c.workspaceGeneration,
  screenId: c.screen.id,
  definition: !!c.activeDefinition,
  selectedIds: c.selectedIds,
});
const objectTarget = (form: HTMLFormElement, data: FormData) => ({
  data,
  objectId: form.dataset.objectId,
  targetKey: form.dataset.targetKey,
});
const selectedContext = (c: FormCommandContext) => ({
  generation: c.workspaceGeneration,
  screenId: c.screen.id,
  definition: !!c.activeDefinition,
  selected: c.selected,
});

/** 種類ごとのコマンド生成。種類を足して handler を書き忘れると型検査が失敗する。 */
export const FORM_COMMANDS: Record<CommandFormKind, FormCommandHandler> = {
  "symbol-slot": (form, data, c) =>
    symbolSlotFormCommand(
      {
        connected: form.isConnected,
        targetKey: form.dataset.targetKey,
        symbolId: form.dataset.symbolId,
        slotName: form.dataset.slotName,
        action: form.dataset.slotAction,
        data,
      },
      {
        project: c.project,
        generation: c.workspaceGeneration,
        definitionId: c.activeDefinition?.id,
      },
    ),
  "equipment-type": (form, data, c) =>
    equipmentTypeFormCommand(
      {
        connected: form.isConnected,
        targetKey: form.dataset.targetKey,
        typeId: form.dataset.typeId,
        data,
      },
      c.project,
      c.workspaceGeneration,
    ),
  equipment: (form, _data, c) =>
    equipmentFormCommand(form, c.project, c.workspaceGeneration),
  "background-crop": (form, data, c) =>
    backgroundCropCommand(
      {
        data,
        connected: form.isConnected,
        targetKey: form.dataset.targetKey,
        assetId: form.dataset.assetId,
      },
      {
        generation: c.workspaceGeneration,
        screenId: c.screen.id,
        definition: !!c.activeDefinition,
        image: c.backgroundScreen?.backgroundImage,
        asset: c.project.assets.find(
          (asset) => asset.id === c.backgroundScreen?.backgroundImage?.assetId,
        ),
      },
    ),
  "background-image": (form, data, c) =>
    backgroundImageCommand(
      { data, targetKey: form.dataset.targetKey },
      {
        generation: c.workspaceGeneration,
        screenId: c.screen.id,
        definition: !!c.activeDefinition,
        image: c.backgroundScreen?.backgroundImage,
      },
    ),
  "line-connection": (form, data, c) =>
    lineConnectionCommand(
      {
        connected: form.isConnected,
        composing: form.dataset.composing === "true",
        objectId: form.dataset.objectId,
        targetKey: form.dataset.targetKey,
        endpoint: form.dataset.endpoint,
        data,
      },
      { ...selectedContext(c), objects: c.screen.objects },
    ),
  "image-fit": (form, data, c) =>
    imageFitCommand(
      {
        data,
        connected: form.isConnected,
        objectId: form.dataset.objectId,
        targetKey: form.dataset.targetKey,
      },
      selectedContext(c),
    ),
  "image-crop": (form, data, c) =>
    imageCropCommand(
      {
        data,
        objectId: form.dataset.objectId,
        targetKey: form.dataset.targetKey,
        assetId: form.dataset.assetId,
      },
      { ...selectedContext(c), assets: c.project.assets },
    ),
  "shape-paint": (form, data, c) =>
    shapePaintCommand(objectTarget(form, data), selectedContext(c)),
  "shape-label": (form, data, c) =>
    shapeLabelCommand(objectTarget(form, data), {
      ...selectedContext(c),
      background: labelCanvasBackground(c.screen),
    }),
  "state-color": (form, data, c) =>
    stateColorCommand(objectTarget(form, data), {
      ...selectedContext(c),
      owner: c.screen,
    }),
  "numeric-format": (form, data, c) =>
    numericFormatCommand(objectTarget(form, data), selectedContext(c)),
  "alarm-color": (form, data, c) =>
    alarmColorCommand(objectTarget(form, data), selectedContext(c)),
  "bool-display": (form, data, c) =>
    boolDisplayCommand(objectTarget(form, data), selectedContext(c)),
  "state-text-color": (form, data, c) =>
    stateTextColorCommand(objectTarget(form, data), {
      ...selectedContext(c),
      readSlots: ("readSlots" in c.screen ? c.screen.readSlots : []) ?? [],
    }),
  "symbol-color-mode": (form, data, c) =>
    symbolColorModeCommand(objectTarget(form, data), selectedContext(c)),
  "selection-outline": (form, data, c) =>
    selectionOutlineCommand(selectionTarget(form, data), selectionContext(c)),
  "selection-line": (form, data, c) =>
    selectionLineCommand(selectionTarget(form, data), selectionContext(c)),
  "selection-text-style": (form, data, c) =>
    selectionTextStyleCommand(selectionTarget(form, data), selectionContext(c)),
  "selection-size": (form, data, c) =>
    selectionSizeCommand(selectionTarget(form, data), selectionContext(c)),
  "selection-opacity": (form, data, c) =>
    selectionOpacityCommand(selectionTarget(form, data), selectionContext(c)),
  "selection-paint-alpha": (form, data, c) =>
    selectionPaintAlphaCommand(
      selectionTarget(form, data),
      selectionContext(c),
    ),
  "selection-color": (form, data, c) =>
    selectionColorCommand(selectionTarget(form, data), selectionContext(c)),
  project: (_form, data) => projectFormCommand(data),
  "operator-frame": (_form, data) => operatorFrameFormCommand(data),
  "alarm-definition": (form, data, c) => {
    const base = c.project.alarms?.definitions.find(
      (row) => row.id === form.dataset.alarmId,
    );
    if (!base) throw new Error("警報の定義が見つかりません");
    return alarmDefinitionFormCommand(
      data,
      base,
      c.catalogSelection.available
        ? c.catalogSelection.catalog.tags
        : undefined,
    );
  },
  screen: (_form, data, c) =>
    screenFormCommand(data, {
      screenId: c.screen.id,
      definitionId: c.activeDefinition?.id,
    }),
  "group-name": (form, data, c) =>
    groupNameFormCommand(
      {
        data,
        targetKey: form.dataset.targetKey,
        groupId: form.dataset.groupId,
      },
      {
        generation: c.workspaceGeneration,
        screenId: c.screen.id,
        groupId: c.activeGroup?.id,
      },
    ),
  move: (_form, data, c) =>
    moveFormCommand(data, {
      screenId: c.screen.id,
      selectedIds: c.selectedIds,
    }),
  object: objectCommand,
};

const trimEquipmentFields: FormAcknowledgeHandler = (form) => {
  for (const name of ["code", "name"]) {
    const input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (input) input.value = input.value.trim();
  }
};

/**
 * 適用後の固有確定（入力欄を確定値へ揃える）。持たない種類は共通の
 * `drafts.submitted` だけで済む。共通の確定は App の `acknowledgeForm` が後で行う。
 */
export const FORM_ACKNOWLEDGES: Partial<
  Record<CommandFormKind, FormAcknowledgeHandler>
> = {
  "symbol-slot": (form) => acknowledgeSymbolSlotForm(form),
  equipment: trimEquipmentFields,
  "equipment-type": trimEquipmentFields,
  "group-name": (form, c) => {
    const input = form.querySelector<HTMLInputElement>('input[name="name"]');
    if (input) input.value = c.activeGroup?.name ?? "";
  },
  "selection-outline": (form) => acknowledgeSelectionOutline(form),
  "selection-line": (form) => acknowledgeSelectionLine(form),
  "selection-color": (form) => acknowledgeSelectionColor(form),
  "selection-opacity": (form) => acknowledgeSelectionOpacity(form),
  "selection-paint-alpha": (form) => acknowledgeSelectionPaintAlpha(form),
  "selection-size": (form) => acknowledgeSelectionSize(form),
  "selection-text-style": (form) => acknowledgeSelectionTextStyle(form),
  project: (form, c) => acknowledgeProjectForm(form, c.project.manifest.name),
  object: (form, c) =>
    acknowledgeObjectForm(
      form,
      c.selected?.name ?? "",
      c.selected?.shape.type === "text" ? c.selected.shape.text : undefined,
    ),
};

/**
 * `data-editor-form` が無い・登録表に無いフォームの扱い。変更前と同じく
 * 通常配置（Inspector の図形）のフォームとして解析する（例外にしない）。
 */
export function unregisteredFormCommand(
  form: HTMLFormElement,
  data: FormData,
  context: FormCommandContext,
): EditCommand {
  return objectCommand(form, data, context);
}

/** フォームの種類に応じた編集コマンドを作る。`data` は試験で差し替えられる。 */
export function formCommand(
  form: HTMLFormElement,
  context: FormCommandContext,
  data: FormData = new FormData(form),
): EditCommand {
  const kind = form.dataset.editorForm;
  if (isCommandFormKind(kind)) return FORM_COMMANDS[kind](form, data, context);
  return unregisteredFormCommand(form, data, context);
}

/** 種類ごとの固有確定。共通の `drafts.submitted` は呼ばない（App が後で呼ぶ）。 */
export function acknowledgeFormKind(
  form: HTMLFormElement,
  context: FormCommandContext,
): void {
  const kind = form.dataset.editorForm;
  if (isCommandFormKind(kind)) FORM_ACKNOWLEDGES[kind]?.(form, context);
}
