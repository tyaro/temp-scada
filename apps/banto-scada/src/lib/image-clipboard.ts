import { CLIPBOARD_LIMIT } from "./clipboard";
import { IMAGE_LIMIT } from "./image-assets";
export type PastePayload =
  { kind: "text"; text: string } | { kind: "image"; file: File };
function objectText(text: string): boolean {
  // Our envelope starts with format. Preserve its priority even if truncated or oversized.
  if (/^\s*\{\s*"format"\s*:\s*"banto-scada\.objects"/.test(text)) return true;
  if (text.length > CLIPBOARD_LIMIT) return false;
  try {
    return JSON.parse(text)?.format === "banto-scada.objects";
  } catch {
    return false;
  }
}
/** Read event-owned data synchronously; never retain a DataTransfer past its event. */
export function selectPastePayload(
  text: string,
  files: readonly File[],
): PastePayload {
  if (objectText(text)) return { kind: "text", text };
  if (!files.length) return { kind: "text", text };
  if (files.length !== 1)
    throw new Error(
      "画像は1枚ずつ貼り付けてください。複数画像はまだ対応していません。",
    );
  const file = files[0];
  if (!["image/png", "image/jpeg"].includes(file.type))
    throw new Error("画像貼り付けは静止PNG／JPEGに対応しています。");
  if (file.size > IMAGE_LIMIT)
    throw new Error("画像は8MiB以下にしてください。");
  return { kind: "image", file };
}
/** Explicit menu action only. Native Ctrl+V uses its ClipboardEvent instead. */
export async function readSystemPaste(
  clipboard: Pick<Clipboard, "read" | "readText">,
): Promise<PastePayload> {
  if (typeof clipboard.read !== "function")
    return { kind: "text", text: await clipboard.readText() };
  let items: ClipboardItems;
  try {
    items = await clipboard.read();
  } catch {
    throw new Error(
      "クリップボードを読み取れませんでした。キャンバスでCtrl／Command＋V、または「画像を配置」を使ってください。",
    );
  }
  const texts = items.filter((item) => item.types.includes("text/plain"));
  if (texts.length > 1)
    throw new Error("複数のテキストを含む貼り付けには対応していません。");
  let text = "";
  if (texts[0]) {
    const blob = await texts[0].getType("text/plain");
    if (blob.size > CLIPBOARD_LIMIT)
      throw new Error("クリップボードのデータが4MiBを超えています");
    text = await blob.text();
  }
  if (objectText(text)) return { kind: "text", text };
  const images = items.flatMap((item) => {
    // PNG and JPEG in the same item are alternative encodings of a single image.
    const mime = item.types.includes("image/png")
      ? "image/png"
      : item.types.includes("image/jpeg")
        ? "image/jpeg"
        : item.types.find((type) => type.startsWith("image/"));
    return mime ? [{ item, mime }] : [];
  });
  if (images.length > 1)
    throw new Error(
      "画像は1枚ずつ貼り付けてください。複数画像はまだ対応していません。",
    );
  if (!images.length) return { kind: "text", text };
  const { item, mime } = images[0];
  if (!["image/png", "image/jpeg"].includes(mime))
    throw new Error("画像貼り付けは静止PNG／JPEGに対応しています。");
  const blob = await item.getType(mime);
  return selectPastePayload(text, [
    new File(
      [blob],
      mime === "image/png" ? "貼り付け画像.png" : "貼り付け画像.jpg",
      { type: mime },
    ),
  ]);
}
