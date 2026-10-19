export interface SelectionStyleInput {
  data: Pick<FormData, "get">;
  targetKey?: string;
  objectIds?: string;
}
export interface SelectionStyleContext {
  generation: number;
  screenId: string;
  definition: boolean;
  selectedIds: readonly string[];
}
/** A deferred form belongs to one owner and exactly the captured selection. */
export function selectionStyleTarget(
  input: SelectionStyleInput,
  context: SelectionStyleContext,
): string[] {
  if (
    input.targetKey !==
    `${context.generation}:${context.screenId}:${context.definition}`
  )
    throw new Error(
      "スタイルの適用先が変更されています。選択し直してください。",
    );
  const ids: unknown = JSON.parse(input.objectIds ?? "[]");
  if (
    !Array.isArray(ids) ||
    ids.length !== context.selectedIds.length ||
    ids.some(
      (id) => typeof id !== "string" || !context.selectedIds.includes(id),
    )
  )
    throw new Error(
      "スタイルの適用対象が変更されています。選択し直してください。",
    );
  return ids as string[];
}
