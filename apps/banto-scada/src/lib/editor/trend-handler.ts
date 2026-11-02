import type { Project } from "../project";
import type { ProjectCommand } from "./commands";
import { parseTrendDefinitions } from "../trend-definitions";
import { newId } from "./model-helpers";

export function applyTrendCommand(
  next: Project,
  command: Extract<ProjectCommand, { type: "save-trend" | "remove-trend" }>,
) {
  const rows = next.trends ?? [];
  if (command.type === "remove-trend") {
    if (!rows.some((row) => row.id === command.trendId))
      throw Error("トレンド定義が見つかりません");
    if (
      next.screens.some((s) =>
        s.objects.some(
          (o) =>
            o.shape.type === "trend" && o.shape.trendId === command.trendId,
        ),
      )
    )
      throw Error("参照配置が残っているトレンド定義は削除できません");
    next.trends = rows.filter((row) => row.id !== command.trendId);
    return;
  }
  const exists = rows.some((row) => row.id === command.definition.id);
  if (command.create === exists)
    throw Error("トレンド定義の作成・更新対象を確認してください");
  const definitions = command.create
    ? [...rows, command.definition]
    : rows.map((row) =>
        row.id === command.definition.id ? command.definition : row,
      );
  next.trends = [
    ...parseTrendDefinitions({
      version: 1,
      kind: "trendDefinitions",
      definitions,
    }).definitions,
  ];
  if (command.placement) {
    const screen = next.screens.find(
      (row) => row.id === command.placement!.screenId,
    );
    if (!screen) throw Error("配置する画面が見つかりません");
    screen.objects.push({
      id: newId(),
      order: Math.max(-1, ...screen.objects.map((row) => row.order)) + 1,
      rotation: 0,
      ...command.placement.frame,
      shape: { type: "trend", trendId: command.definition.id },
    });
  }
}
