import type { SymbolDefinition } from "./project";
import library from "./symbol-library.json";

/** Built-in part templates. The key order is the palette and menu order. */
export type BuiltinTemplate = keyof typeof library;

export interface BuiltinPart {
  template: BuiltinTemplate;
  /** Display name. Same as the definition name. */
  name: string;
  /** Extra search words for the palette. */
  keywords: string;
}

const keywords: Record<BuiltinTemplate, string> = {
  pump: "ポンプ pump",
  valve: "バルブ 弁 valve",
  blower: "ブロワー ブロワ 送風機 ファン blower fan",
  tank: "槽 タンク 貯槽 容器 tank vessel",
  tower: "塔 カラム 蒸留塔 吸収塔 tower column",
  cyclone: "サイクロン 集じん 集塵 cyclone",
  heatExchanger: "熱交換器 熱交 heat exchanger",
  agitator: "撹拌機 攪拌機 かくはん ミキサー agitator mixer",
  conveyor: "コンベヤ コンベア ベルトコンベヤ conveyor belt",
  screw: "スクリュー スクリューコンベヤ screw conveyor",
  motor: "モーター モータ 電動機 motor",
};

export const BUILTIN_PARTS: readonly BuiltinPart[] = (
  Object.keys(library) as BuiltinTemplate[]
).map((template) => ({
  template,
  name: library[template].name,
  keywords: keywords[template],
}));

export function isBuiltinTemplate(value: string): value is BuiltinTemplate {
  return Object.hasOwn(library, value);
}

/** The shared template. Callers copy it before putting it into a Project. */
export function builtinDefinition(template: BuiltinTemplate): SymbolDefinition {
  return library[template] as unknown as SymbolDefinition;
}

export function builtinName(template: BuiltinTemplate): string {
  return library[template].name;
}
