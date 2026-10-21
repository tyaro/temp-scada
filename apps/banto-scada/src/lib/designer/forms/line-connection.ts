import type { EditCommand } from "../../editor";
import type { ScreenObject } from "../../project";
import { CONNECTION_ANCHORS, type ConnectionAnchor } from "../../connections";
export function lineConnectionCommand(
  input: {
    connected: boolean;
    composing?: boolean;
    objectId?: string;
    targetKey?: string;
    endpoint?: string;
    data: Pick<FormData, "get">;
  },
  context: {
    generation: number;
    screenId: string;
    definition: boolean;
    selected: ScreenObject | undefined;
    objects: readonly ScreenObject[];
  },
): EditCommand {
  if (
    !input.connected ||
    context.definition ||
    context.selected?.shape.type !== "polyline" ||
    input.objectId !== context.selected.id ||
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}` ||
    (input.endpoint !== "start" && input.endpoint !== "end")
  )
    throw new Error("接続設定の対象が変わりました。線を選び直してください。");
  if (input.composing)
    throw new Error("接続設定の文字変換を確定してから適用してください。");
  const targetId = input.data.get("connectionTarget");
  if (typeof targetId !== "string") throw new Error("接続先を選んでください");
  const base = {
    type: "set-line-connection" as const,
    screenId: context.screenId,
    objectId: context.selected.id,
    endpoint: input.endpoint,
  } as const;
  if (!targetId) return { ...base, connection: null };
  const target = context.objects.find((o) => o.id === targetId);
  if (target?.shape.type !== "symbol")
    throw new Error("接続先のSymbol配置が変わりました。選び直してください。");
  const anchor = input.data.get("connectionAnchor");
  if (!CONNECTION_ANCHORS.includes(anchor as ConnectionAnchor))
    throw new Error("接続位置を選んでください");
  return {
    ...base,
    connection: {
      targetObjectId: targetId,
      anchor: anchor as ConnectionAnchor,
    },
  };
}
