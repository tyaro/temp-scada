import type { PalettePart } from "./palette-drag";
import type { SymbolDefinition } from "../project";
import { builtinName, isBuiltinTemplate } from "../builtin-symbols";
export const DEFAULT_FAVORITES = [
  "builtin:pump",
  "builtin:valve",
  "basic:text",
];
export const FAVORITES_LIMIT = 64;
const basic = [
  "rectangle",
  "ellipse",
  "text",
  "line",
  "pipe",
  "level",
  "table",
  "navButton",
] as const;
const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const symbolKey = new RegExp(`^symbol:${uuid}:${uuid}$`);
export function favoriteKey(part: PalettePart, projectId: string): string {
  return part.type === "symbol"
    ? `symbol:${projectId}:${part.symbolId}`
    : part.type === "builtin"
      ? `builtin:${part.template}`
      : `basic:${part.kind}`;
}
export function parseFavorites(raw: string | null | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!Array.isArray(value) || value.length > FAVORITES_LIMIT)
      return [...DEFAULT_FAVORITES];
    return [
      ...new Set(
        value.filter(
          (key): key is string =>
            typeof key === "string" &&
            (builtinTemplate(key) !== undefined ||
              basic.some((kind) => key === `basic:${kind}`) ||
              symbolKey.test(key)),
        ),
      ),
    ];
  } catch {
    return [...DEFAULT_FAVORITES];
  }
}
function builtinTemplate(key: string) {
  const name = key.startsWith("builtin:") ? key.slice(8) : undefined;
  return name !== undefined && isBuiltinTemplate(name) ? name : undefined;
}
export type FavoriteItem = {
  key: string;
  part: PalettePart;
  label: string;
  definition?: SymbolDefinition;
};
export function availableFavorites(
  keys: string[],
  projectId: string,
  definitions: SymbolDefinition[],
  allowSymbols: boolean,
): FavoriteItem[] {
  return keys.flatMap((key): FavoriteItem[] => {
    const kind = basic.find((kind) => key === `basic:${kind}`);
    // 画面切替ボタンは画面の直下だけ。Symbol 定義の編集中は出さない。
    if (kind === "navButton" && !allowSymbols) return [];
    if (kind)
      return [
        {
          key,
          part: { type: "basic", kind },
          label: {
            rectangle: "四角形",
            ellipse: "円・楕円",
            text: "テキスト",
            line: "線",
            pipe: "配管",
            level: "液位",
            table: "表",
            navButton: "画面切替ボタン",
          }[kind],
        },
      ];
    if (!allowSymbols) return [];
    const template = builtinTemplate(key);
    if (template)
      return [
        {
          key,
          part: { type: "builtin", template },
          label: builtinName(template),
        },
      ];
    const definition = definitions.find(
      (definition) =>
        key ===
        favoriteKey({ type: "symbol", symbolId: definition.id }, projectId),
    );
    return definition
      ? [
          {
            key,
            part: { type: "symbol", symbolId: definition.id },
            label: `${definition.name}（共有定義）`,
            definition,
          },
        ]
      : [];
  });
}
