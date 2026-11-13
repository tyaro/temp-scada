import type { AddKind } from "../editor";
import type { BuiltinTemplate } from "../builtin-symbols";

/** Transfer only an opaque token. The part and target stay in this editor session. */
export const PALETTE_MIME = "application/x-banto-scada-part";
export type PalettePart =
  | { type: "basic"; kind: AddKind }
  | { type: "builtin"; template: BuiltinTemplate }
  | { type: "symbol"; symbolId: string };
