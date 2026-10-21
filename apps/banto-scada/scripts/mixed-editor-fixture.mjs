/** Reproducible public-only mixed drawing; no customer data or imported screenshots. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
const sample = JSON.parse(
  readFileSync(
    new URL("../../../examples/minimal.project.json", import.meta.url),
  ),
);
const symbols = JSON.parse(
  readFileSync(
    new URL("../../../examples/symbol-color.project.json", import.meta.url),
  ),
);
const id = (n) => `0199fca5-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type),
    out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length);
  name.copy(out, 4);
  bytes.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, bytes])), out.length - 4);
  return out;
}
export function fixturePng(seed) {
  const width = 1024,
    height = 512;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      const pipe =
        Math.abs(y - (180 + seed * 30)) < 18 ||
        (Math.abs(x - (240 + seed * 90)) < 18 && y > 100 && y < 410);
      pixels[offset] = pipe ? 30 : 215 + ((x + seed * 7) % 30);
      pixels[offset + 1] = pipe ? 140 + seed * 10 : 222 + (y % 20);
      pixels[offset + 2] = pipe ? 180 : 240;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export function mixedFixture(count) {
  assert(
    Number.isInteger(count) && count >= 25 && count <= 1000 && count % 5 === 0,
  );
  const project = structuredClone(sample);
  project.manifest.projectId = id(1);
  project.manifest.name = `混在工程図 ${count}配置`;
  project.symbols = structuredClone(symbols.symbols);
  const originals = Array.from({ length: 4 }, (_, index) => {
    const bytes = fixturePng(index);
    return {
      bytes,
      metadata: {
        id: id(10 + index),
        sha256: hash(bytes),
        mime: "image/png",
        byteLength: bytes.length,
        width: 1024,
        height: 512,
        name: `自作配管パターン${index + 1}.png`,
      },
    };
  });
  project.assets = originals.map((item) => item.metadata);
  const screen = project.screens[0];
  screen.id = id(2);
  screen.name = "混在設備図";
  screen.width = 1920;
  screen.height = 1080;
  screen.background = "#ffffff";
  screen.folders = Array.from({ length: 5 }, (_, index) => ({
    id: id(30 + index),
    name: ["装置枠", "運転メモ", "共有ポンプ", "原本画像", "配管"][index],
    order: index,
  }));
  const units = count / 5,
    columns = Math.ceil(Math.sqrt(units * 1.7)),
    rows = Math.ceil(units / columns);
  const w = 1800 / columns,
    h = 960 / rows;
  screen.objects = Array.from({ length: count }, (_, index) => {
    const unit = Math.floor(index / 5),
      kind = index % 5;
    const x = 50 + (unit % columns) * w,
      y = 45 + Math.floor(unit / columns) * h;
    const base = {
      id: id(100 + index),
      order: index,
      x,
      y,
      width: w - 10,
      height: h - 10,
      rotation: 0,
      folderId: screen.folders[kind].id,
      name: `${["装置", "運転メモ", "ポンプ", "画像", "配管"][kind]} ${unit + 1}`,
    };
    if (kind === 0)
      return {
        ...base,
        shape: {
          type: "rectangle",
          paint: {
            fill: {
              enabled: true,
              paint: {
                type: "solid",
                color: unit % 2 ? "#eff6ff" : "#ecfdf5",
                alpha: 1,
              },
            },
            stroke: { color: "#cbd5e1", width: 1 },
          },
        },
      };
    if (kind === 1)
      return {
        ...base,
        x: x + 4,
        y: y + 3,
        width: w - 18,
        height: h * 0.35,
        fill: "#172846",
        shape: {
          type: "text",
          text: `P-${unit + 101} 確認\n原水供給・循環ポンプ`,
          style: {
            fontSize: Math.min(14, Math.max(8, h * 0.11)),
            fontWeight: "normal",
            align: "left",
            wrap: "word",
          },
        },
      };
    if (kind === 2)
      return {
        ...base,
        x: x + 5,
        y: y + h * 0.43,
        width: w * 0.42,
        height: h * 0.44,
        fill: "#0891b2",
        shape: {
          type: "symbol",
          symbolId: project.symbols[0].id,
          colorMode: "definition",
        },
      };
    if (kind === 3)
      return {
        ...base,
        fill: "#ffffff",
        x: x + w * 0.5,
        y: y + h * 0.43,
        width: w * 0.36,
        height: h * 0.38,
        shape: {
          type: "image",
          assetId: project.assets[unit % 4].id,
          fit: "contain",
        },
      };
    delete base.width;
    delete base.height;
    return {
      ...base,
      x: 0,
      y: 0,
      fill: "#0284c7",
      shape: {
        type: "polyline",
        points: [
          { x: x + w * 0.2, y: y + h * 0.9 },
          { x: x + w * 0.8, y: y + h * 0.9 },
        ],
        strokeWidth: 2,
        arrow: "end",
      },
    };
  });
  const source = new Map(originals.map((item) => [item.metadata.sha256, item]));
  // Read-only fixture source for the real package writer; browser import performs real decode.
  const store = {
    pin(hashes) {
      for (const key of hashes) assert(source.has(key));
      return () => {};
    },
    metadata(key) {
      assert(source.has(key));
      return source.get(key).metadata;
    },
    blob(key) {
      assert(source.has(key));
      return new Blob([source.get(key).bytes], { type: "image/png" });
    },
  };
  return { project, originals, store, hash };
}
