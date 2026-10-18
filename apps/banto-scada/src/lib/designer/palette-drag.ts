import type { AddKind } from "../editor";

/** Transfer only an opaque token. The part and target stay in this editor session. */
export const PALETTE_MIME = "application/x-banto-scada-part";
export type PalettePart =
  | { type: "basic"; kind: AddKind }
  | { type: "builtin"; template: "pump" | "valve" }
  | { type: "symbol"; symbolId: string };
