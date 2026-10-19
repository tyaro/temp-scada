import { expect, it, vi } from "vitest";
import { selectPastePayload, readSystemPaste } from "./image-clipboard";
import { IMAGE_LIMIT } from "./image-assets";
const png = () =>
  new File([new Uint8Array([1, 2, 3])], "clip.png", { type: "image/png" });
const item = (values: Record<string, Blob>) =>
  ({
    types: Object.keys(values),
    getType: vi.fn(async (type: string) => values[type]),
  }) as unknown as ClipboardItem;
it("prefers SCADA envelopes including malformed and oversized payloads, but chooses an image over ordinary text", () => {
  const file = png();
  for (const text of [
    '{"format":"banto-scada.objects","version":99}',
    '{"format":"banto-scada.objects",',
    '{"format":"banto-scada.objects","padding":"' +
      "a".repeat(4 * 1024 * 1024) +
      '"}',
  ])
    expect(selectPastePayload(text, [file])).toEqual({ kind: "text", text });
  expect(selectPastePayload("https://example.invalid/photo", [file])).toEqual({
    kind: "image",
    file,
  });
  expect(selectPastePayload("plain", [])).toEqual({
    kind: "text",
    text: "plain",
  });
});
it("rejects multiple and unsupported files and size overflow without choosing the first image", () => {
  expect(() => selectPastePayload("", [png(), png()])).toThrow(/1枚/);
  expect(() =>
    selectPastePayload("", [new File(["gif"], "x.gif", { type: "image/gif" })]),
  ).toThrow(/PNG/);
  expect(() =>
    selectPastePayload("", [
      new File([new Uint8Array(IMAGE_LIMIT + 1)], "x.png", {
        type: "image/png",
      }),
    ]),
  ).toThrow(/8MiB/);
});
it("reads menu data once, treats image encodings as alternatives, and does not fetch HTML URLs", async () => {
  const blob = png(),
    getType = vi.fn(async (type: string) =>
      type === "image/png" ? blob : new Blob(["description"]),
    );
  const clipboard = {
    read: vi.fn(async () => [
      {
        types: ["text/plain", "image/jpeg", "image/png", "text/html"],
        getType,
      },
    ]),
    readText: vi.fn(),
  };
  const result = await readSystemPaste(clipboard as any);
  expect(result.kind).toBe("image");
  if (result.kind === "image")
    expect(await result.file.arrayBuffer()).toEqual(await blob.arrayBuffer());
  expect(getType.mock.calls.map((c) => c[0])).toEqual([
    "text/plain",
    "image/png",
  ]);
  expect(clipboard.read).toHaveBeenCalledOnce();
  expect(clipboard.readText).not.toHaveBeenCalled();
});
it("prioritizes SCADA text without reading accompanying image bytes and rejects ambiguous menu images", async () => {
  const text = '{"format":"banto-scada.objects","version":99}';
  const entry = item({ "text/plain": new Blob([text]), "image/png": png() });
  expect(await readSystemPaste({ read: async () => [entry] } as any)).toEqual({
    kind: "text",
    text,
  });
  expect(entry.getType).toHaveBeenCalledOnce();
  await expect(
    readSystemPaste({
      read: async () => [
        item({ "image/png": png() }),
        item({ "image/jpeg": png() }),
      ],
    } as any),
  ).rejects.toThrow(/1枚/);
});
it("retains text fallback for older browsers and reports denied image API without retrying another permission path", async () => {
  const readText = vi.fn(async () => "plain");
  expect(await readSystemPaste({ readText } as any)).toEqual({
    kind: "text",
    text: "plain",
  });
  readText.mockClear();
  await expect(
    readSystemPaste({
      read: async () => {
        throw new Error("denied");
      },
      readText,
    } as any),
  ).rejects.toThrow(/Ctrl/);
  expect(readText).not.toHaveBeenCalled();
});
