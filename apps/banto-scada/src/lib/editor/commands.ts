import type { EquipmentSlot, EquipmentBinding } from "../equipment";
import type { ImageCrop } from "../image-crop";
import type {
  BackgroundImage,
  ImageAsset,
  LineStyle,
  Point,
  ShapePaint,
  TagBinding,
  TextStyle,
} from "../project";
export type AddKind = "rectangle" | "ellipse" | "text" | "line" | "pipe";
export interface ObjectPatch {
  opacity?: number;
  colorAlpha?: number;
  rotation?: number;
  fontSize?: number;
  textStyle?: TextStyle;
  paint?: ShapePaint;
  name?: string | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  text?: string;
  binding?: TagBinding | null;
  symbolId?: string;
  sourceScreenId?: string;
  colorMode?: "monochrome" | "definition";
  points?: Point[];
  strokeWidth?: number;
  arrow?: "none" | "end";
  lineStyle?: LineStyle;
}
export interface OutlineStylePatch {
  lineStyle?: LineStyle;
  mode?: "none" | "enabled";
  color?: string;
  width?: number;
}
export type AlignMode =
  "left" | "right" | "top" | "bottom" | "center-x" | "center-y";
export type ScreenCommand =
  | {
      type: "set-background-image";
      screenId: string;
      image: BackgroundImage | null;
      asset?: ImageAsset;
    }
  | {
      type: "create-screen";
      name: string;
      width: number;
      height: number;
      background?: string;
    }
  | {
      type: "update-screen";
      background?: string;
      screenId: string;
      name: string;
      width: number;
      height: number;
    }
  | { type: "reorder-screen"; screenId: string; direction: "up" | "down" }
  | { type: "duplicate-screen"; screenId: string }
  | { type: "remove-screen"; screenId: string };
export type ObjectCommand = (
  | { type: "group"; screenId: string; objectIds: string[]; name?: string }
  | { type: "ungroup"; screenId: string; groupId: string }
  | { type: "rename-group"; screenId: string; groupId: string; name?: string }
  | {
      type: "rotate-groups";
      screenId: string;
      objectIds: string[];
      delta: 90 | -90;
    }
  | {
      type: "set-group-state";
      screenId: string;
      groupId: string;
      locked?: boolean;
      visible?: boolean;
    }
  | {
      type: "reorder-group";
      screenId: string;
      groupId: string;
      direction: "front" | "back" | "forward" | "backward";
    }
  | {
      type: "add-screen-view";
      screenId: string;
      sourceScreenId: string;
      frame: { x: number; y: number; width: number; height: number };
    }
  | {
      type: "add-image";
      screenId: string;
      asset: ImageAsset;
      frame: { x: number; y: number; width: number; height: number };
    }
  | {
      type: "replace-image";
      screenId: string;
      objectId: string;
      asset: ImageAsset;
    }
  | {
      type: "set-image-crop";
      screenId: string;
      objectId: string;
      crop: ImageCrop | null;
    }
  | { type: "reset-image-ratio"; screenId: string; objectId: string }
  | {
      type: "create-folder";
      screenId: string;
      name: string;
      parentId: string | null;
    }
  | { type: "rename-folder"; screenId: string; folderId: string; name: string }
  | {
      type: "move-folder";
      screenId: string;
      folderId: string;
      parentId: string | null;
    }
  | { type: "remove-folder"; screenId: string; folderId: string }
  | {
      type: "set-folder";
      screenId: string;
      objectIds: string[];
      folderId: string | null;
    }
  | {
      type: "distribute";
      screenId: string;
      objectIds: string[];
      axis: "x" | "y";
    }
  | {
      type: "set-outline-style";
      screenId: string;
      objectIds: string[];
      patch: OutlineStylePatch;
    }
  | {
      type: "set-line-style";
      screenId: string;
      objectIds: string[];
      patch: {
        strokeWidth?: number;
        arrow?: "none" | "end";
        lineStyle?: LineStyle;
      };
    }
  | {
      type: "set-color";
      screenId: string;
      objectIds: string[];
      fill: string;
      convertDefinitionSymbols?: boolean;
    }
  | {
      type: "set-visibility";
      screenId: string;
      objectId: string;
      visible: boolean;
    }
  | { type: "set-lock"; screenId: string; objectId: string; locked: boolean }
  | {
      type: "paste";
      screenId: string;
      text: string;
      origin: string;
      center: Point;
      offset?: number;
    }
  | {
      type: "move-vertex";
      screenId: string;
      objectId: string;
      index: number;
      point: Point;
    }
  | {
      type: "move-many";
      screenId: string;
      objectIds: string[];
      dx: number;
      dy: number;
    }
  | {
      type: "duplicate-many";
      screenId: string;
      objectIds: string[];
    }
  | {
      type: "align";
      screenId: string;
      objectIds: string[];
      alignment: AlignMode;
    }
  | { type: "remove-many"; screenId: string; objectIds: string[] }
  | { type: "add"; screenId: string; kind: AddKind; center?: Point }
  | {
      type: "add-symbol";
      screenId: string;
      template: "pump" | "valve";
      center?: Point;
    }
  | { type: "update"; screenId: string; objectId: string; patch: ObjectPatch }
  | { type: "make-symbol-unique"; screenId: string; objectId: string }
  | { type: "duplicate"; screenId: string; objectId: string }
  | {
      type: "reorder";
      screenId: string;
      objectId: string;
      direction: "front" | "back" | "forward" | "backward";
    }
  | { type: "remove"; screenId: string; objectId: string }
) & { definitionId?: string };

export type EquipmentCommand =
  | { type: "create-equipment-type"; name: string; slots: EquipmentSlot[] }
  | {
      type: "update-equipment-type";
      typeId: string;
      name: string;
      slots: EquipmentSlot[];
    }
  | { type: "remove-equipment-type"; typeId: string }
  | {
      type: "create-equipment";
      typeId: string;
      code: string;
      name: string;
      bindings: EquipmentBinding[];
    }
  | {
      type: "update-equipment";
      equipmentId: string;
      code: string;
      name: string;
      bindings: EquipmentBinding[];
    }
  | { type: "remove-equipment"; equipmentId: string };
export type ProjectCommand =
  { type: "update-project"; name: string } | EquipmentCommand;
export type SymbolCommand =
  | { type: "create-symbol"; name: string; width: number; height: number }
  | {
      type: "update-symbol";
      symbolId: string;
      name: string;
      width: number;
      height: number;
    }
  | { type: "duplicate-symbol"; symbolId: string }
  | { type: "remove-symbol"; symbolId: string }
  | {
      type: "place-symbol";
      symbolId: string;
      screenId: string;
      center?: Point;
    };

export type EditCommand =
  ProjectCommand | ScreenCommand | ObjectCommand | SymbolCommand;

type CommandScopeMap = {
  [K in EditCommand["type"]]: K extends ObjectCommand["type"]
    ? "object"
    : K extends ScreenCommand["type"]
      ? "screen"
      : K extends ProjectCommand["type"]
        ? "project"
        : K extends SymbolCommand["type"]
          ? "symbol"
          : never;
};

const commandScopes = {
  "set-background-image": "screen",
  "create-screen": "screen",
  "update-screen": "screen",
  "reorder-screen": "screen",
  "duplicate-screen": "screen",
  "remove-screen": "screen",
  "add-screen-view": "object",
  "add-image": "object",
  "replace-image": "object",
  "set-image-crop": "object",
  "reset-image-ratio": "object",
  "create-folder": "object",
  "rename-folder": "object",
  "move-folder": "object",
  "remove-folder": "object",
  "set-folder": "object",
  distribute: "object",
  "set-outline-style": "object",
  "set-line-style": "object",
  "set-color": "object",
  "set-visibility": "object",
  "set-lock": "object",
  group: "object",
  ungroup: "object",
  "rename-group": "object",
  "rotate-groups": "object",
  "set-group-state": "object",
  "reorder-group": "object",
  paste: "object",
  "move-vertex": "object",
  "move-many": "object",
  "duplicate-many": "object",
  align: "object",
  "remove-many": "object",
  add: "object",
  "add-symbol": "object",
  update: "object",
  "make-symbol-unique": "object",
  duplicate: "object",
  reorder: "object",
  remove: "object",
  "update-project": "project",
  "create-equipment-type": "project",
  "update-equipment-type": "project",
  "remove-equipment-type": "project",
  "create-equipment": "project",
  "update-equipment": "project",
  "remove-equipment": "project",

  "create-symbol": "symbol",
  "update-symbol": "symbol",
  "duplicate-symbol": "symbol",
  "remove-symbol": "symbol",
  "place-symbol": "symbol",
} satisfies CommandScopeMap;

export function isObjectCommand(
  command: EditCommand,
): command is ObjectCommand {
  return commandScopes[command.type] === "object";
}

export function isSymbolCommand(
  command: EditCommand,
): command is SymbolCommand {
  return commandScopes[command.type] === "symbol";
}

export function isScreenCommand(
  command: EditCommand,
): command is ScreenCommand {
  return commandScopes[command.type] === "screen";
}

export type FolderStructureCommand = Extract<
  ObjectCommand,
  { type: "create-folder" | "rename-folder" | "move-folder" | "remove-folder" }
>;
export type FolderAssignmentCommand = Extract<
  ObjectCommand,
  { type: "set-folder" }
>;

export type ImagePlacementCommand = Extract<
  ObjectCommand,
  { type: "add-image" }
>;
export type ImageEditCommand = Extract<
  ObjectCommand,
  { type: "replace-image" | "set-image-crop" | "reset-image-ratio" }
>;

export function isProjectCommand(
  command: EditCommand,
): command is ProjectCommand {
  return commandScopes[command.type] === "project";
}
export type ObjectStateCommand = Extract<
  ObjectCommand,
  { type: "set-visibility" | "set-lock" }
>;
export type ScreenViewPlacementCommand = Extract<
  ObjectCommand,
  { type: "add-screen-view" }
>;
export type PasteCommand = Extract<ObjectCommand, { type: "paste" }>;
export type GroupCommand = Extract<
  ObjectCommand,
  {
    type:
      | "group"
      | "ungroup"
      | "rename-group"
      | "rotate-groups"
      | "set-group-state"
      | "reorder-group";
  }
>;
export function isGroupCommand(
  command: ObjectCommand,
): command is GroupCommand {
  return [
    "group",
    "ungroup",
    "rename-group",
    "rotate-groups",
    "set-group-state",
    "reorder-group",
  ].includes(command.type);
}
export type SelectionCommand = Exclude<
  Extract<ObjectCommand, { objectIds: string[] }>,
  GroupCommand
>;
export type ObjectCreationCommand = Extract<
  ObjectCommand,
  { type: "add" | "add-symbol" }
>;
export type SingleObjectCommand = Exclude<
  Extract<ObjectCommand, { objectId: string }>,
  ObjectStateCommand
>;
