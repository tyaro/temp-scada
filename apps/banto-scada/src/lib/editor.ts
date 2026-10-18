import {
  parseProject,
  serializeProject,
  type Project,
  type ScreenObject,
} from "./project";
export type EditCommand =
  | { type: "add"; screenId: string; kind: ScreenObject["shape"]["type"] }
  | {
      type: "update";
      screenId: string;
      objectId: string;
      patch: Partial<
        Pick<ScreenObject, "x" | "y" | "width" | "height" | "fill">
      > & { text?: string };
    }
  | { type: "remove"; screenId: string; objectId: string };

/** RFC 9562 UUID v7。ID は順序として使わない。 */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** 変更はコピー上で検証し、失敗時は元の Project を保持する。 */
export function applyCommand(
  project: Project,
  command: EditCommand,
  mode: "edit" | "preview",
): Project {
  if (mode !== "edit") throw new Error("表示プレビューでは編集できません");
  const next = parseProject(serializeProject(project));
  const screen = next.screens.find((s) => s.id === command.screenId);
  if (!screen) throw new Error("画面が見つかりません");
  if (command.type === "add") {
    screen.objects.push({
      id: newId(),
      order: Math.max(-1, ...screen.objects.map((o) => o.order)) + 1,
      x: 40,
      y: 40,
      width: 160,
      height: command.kind === "text" ? 40 : 100,
      fill: "#2dd4bf",
      shape:
        command.kind === "text"
          ? { type: "text", text: "テキスト" }
          : { type: command.kind },
    });
  } else {
    const index = screen.objects.findIndex((o) => o.id === command.objectId);
    if (index < 0) throw new Error("図形が見つかりません");
    if (command.type === "remove") screen.objects.splice(index, 1);
    else {
      const { text, ...geometry } = command.patch;
      const object = screen.objects[index];
      Object.assign(object, geometry);
      if (text !== undefined) {
        if (object.shape.type !== "text")
          throw new Error("Text 以外に文字列は設定できません");
        object.shape.text = text;
      }
    }
  }
  next.manifest.projectRevision++;
  return parseProject(JSON.stringify(next));
}
