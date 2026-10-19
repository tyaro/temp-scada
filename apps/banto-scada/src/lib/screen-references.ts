import type { Project } from "./project";
/** Initial embedded-screen contract: one level, all references (including hidden ones). */
export const MAX_SCREEN_VIEWS = 32;
export const MAX_EXPANDED_PLACEMENTS = 20_000;
export interface ScreenReference {
  readonly screenId: string;
  readonly objectId: string;
  readonly targetScreenId: string;
}
export interface ScreenCost {
  readonly id: string;
  /** Ordinary placements plus expanded Symbol children. View wrappers are counted separately. */
  readonly baseCost: number;
}
export function screenReferences(
  screens: readonly ScreenCost[],
  references: readonly ScreenReference[],
): {
  readonly bySource: ReadonlyMap<string, readonly ScreenReference[]>;
  readonly byTarget: ReadonlyMap<string, readonly ScreenReference[]>;
  readonly expandedCosts: ReadonlyMap<string, number>;
} {
  const costs = new Map<string, number>();
  for (const screen of screens) {
    if (costs.has(screen.id)) throw new Error("画面IDが重複しています。");
    if (!Number.isSafeInteger(screen.baseCost) || screen.baseCost < 0)
      throw new Error("画面の描画配置数が不正です。");
    costs.set(screen.id, screen.baseCost);
  }
  const bySource = new Map<string, ScreenReference[]>(),
    byTarget = new Map<string, ScreenReference[]>(),
    objectIds = new Set<string>();
  for (const reference of references) {
    if (!costs.has(reference.screenId))
      throw new Error("Viewを置く画面が見つかりません。");
    if (!costs.has(reference.targetScreenId))
      throw new Error("参照する画面が見つかりません。");
    if (reference.screenId === reference.targetScreenId)
      throw new Error("自分自身の画面は埋め込めません。");
    if (objectIds.has(reference.objectId))
      throw new Error("埋込配置IDが重複しています。");
    objectIds.add(reference.objectId);
    const row = { ...reference };
    const source = bySource.get(row.screenId) ?? [],
      target = byTarget.get(row.targetScreenId) ?? [];
    source.push(row);
    target.push(row);
    bySource.set(row.screenId, source);
    byTarget.set(row.targetScreenId, target);
    if (source.length > MAX_SCREEN_VIEWS)
      throw new Error(
        `画面内の埋込Viewは${MAX_SCREEN_VIEWS}件以下にしてください。`,
      );
  }
  // Validate the complete graph, not only the screen whose command is being applied.
  // With a one-level contract, any referenced screen with outgoing edges is invalid.
  for (const reference of references)
    if (bySource.has(reference.targetScreenId))
      throw new Error(
        "埋込Viewを持つ画面は埋め込めません（入れ子・循環参照）。",
      );
  const expandedCosts = new Map(costs);
  for (const [id, rows] of bySource) {
    const count =
      costs.get(id)! +
      rows.reduce((sum, row) => sum + 1 + costs.get(row.targetScreenId)!, 0);
    if (!Number.isSafeInteger(count) || count > MAX_EXPANDED_PLACEMENTS)
      throw new Error(
        `埋込後の描画配置数は${MAX_EXPANDED_PLACEMENTS.toLocaleString("ja-JP")}件以下にしてください。`,
      );
    expandedCosts.set(id, count);
  }
  return { bySource, byTarget, expandedCosts };
}

/** Adapter counts hidden placements and Symbol children too; never expands the graph recursively. */
export function projectScreenReferences(project: Project) {
  const symbolCosts = new Map(
    project.symbols.map((s) => [s.id, s.objects.length]),
  );
  return screenReferences(
    project.screens.map((screen) => ({
      id: screen.id,
      baseCost: screen.objects.reduce(
        (sum, object) =>
          sum +
          (object.shape.type === "screenView"
            ? 0
            : object.shape.type === "symbol"
              ? 1 + (symbolCosts.get(object.shape.symbolId) ?? 0)
              : 1),
        0,
      ),
    })),
    project.screens.flatMap((screen) =>
      screen.objects.flatMap((object) =>
        object.shape.type === "screenView"
          ? [
              {
                screenId: screen.id,
                objectId: object.id,
                targetScreenId: object.shape.screenId,
              },
            ]
          : [],
      ),
    ),
  );
}

/** Candidate checks reuse the current graph rather than cloning the Project per option. */
export function screenViewOptions(
  project: Project,
  ownerId: string,
  replacingId?: string,
) {
  const graph = projectScreenReferences(project);
  const owner = project.screens.find((s) => s.id === ownerId);
  if (!owner) return [];
  const outgoing = graph.bySource.get(ownerId) ?? [];
  const replacing = outgoing.find((r) => r.objectId === replacingId);
  const without =
    (graph.expandedCosts.get(ownerId) ?? 0) -
    (replacing ? 1 + graph.expandedCosts.get(replacing.targetScreenId)! : 0);
  return project.screens.map((source) => ({
    id: source.id,
    name: source.name,
    reason:
      source.id === ownerId
        ? "自分自身は埋め込めません"
        : graph.byTarget.has(ownerId)
          ? "この画面は別画面から参照中です"
          : graph.bySource.has(source.id)
            ? "埋込Viewを持つ画面です"
            : outgoing.length - (replacing ? 1 : 0) >= MAX_SCREEN_VIEWS
              ? "画面内の埋込Viewは32件までです"
              : without + 1 + graph.expandedCosts.get(source.id)! >
                  MAX_EXPANDED_PLACEMENTS
                ? "展開後の配置数が20,000件を超えます"
                : null,
  }));
}
