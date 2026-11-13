import { describe, expect, it } from "vitest";
import sample from "../../../../examples/read-presentation.project.json";
import cases from "../../../../examples/table-cases.json";
import { parseProject, serializeProject, type TableShape } from "./project";
import { applyCommand } from "./editor";
import {
  buildTableCells,
  formatTableColors,
  formatTableText,
  formatTableWeights,
  parseTableColors,
  parseTableText,
  parseTableWeights,
  tableCellBoxes,
  tableEdges,
} from "./table";
import { objectFormCommand } from "./designer/forms/object-form";
import { objectFormValues } from "./designer/numeric-properties";
import { canFlip } from "./flip";

it.each(cases)("table contract: $name", ({ target, valid, object }) => {
  const value = structuredClone(sample),
    node = target
      .split("/")
      .slice(1)
      .reduce((node, key) => node[key], value as any);
  node.push(object);
  if (valid)
    expect(
      parseProject(serializeProject(parseProject(JSON.stringify(value)))),
    ).toEqual(value);
  else expect(() => parseProject(JSON.stringify(value))).toThrow();
});

describe("table geometry", () => {
  it("divides the frame by the weights and ends exactly at the length", () => {
    expect(tableEdges([2, 1, 1], 200)).toEqual([0, 100, 150, 200]);
    const edges = tableEdges([1, 1, 1], 100);
    expect(edges[3]).toBe(100);
  });
  it("places each cell", () => {
    const shape = cases[0].object.shape as TableShape;
    const boxes = tableCellBoxes(shape, 240, 60);
    expect(boxes).toHaveLength(6);
    expect(boxes[4]).toMatchObject({
      row: 1,
      column: 1,
      x: 120,
      y: 30,
      width: 60,
      height: 30,
    });
  });
});

describe("table text input", () => {
  it("pads short rows and drops the trailing newline of a pasted range", () => {
    expect(parseTableText("a\tb\tc\r\nd\n")).toEqual([
      ["a", "b", "c"],
      ["d", "", ""],
    ]);
    expect(parseTableText("")).toEqual([[""]]);
  });
  it("rejects more rows or columns than the limits", () => {
    expect(() => parseTableText(Array(101).fill("a").join("\n"))).toThrow(
      "100行まで",
    );
    expect(() => parseTableText(Array(33).fill("a").join("\t"))).toThrow(
      "32列まで",
    );
    expect(() => parseTableText("x".repeat(257))).toThrow("256文字");
    // 文字数はコードポイントで数える（schema の maxLength と同じ）。
    expect(parseTableText("😀".repeat(256))[0][0]).toHaveLength(512);
    expect(() => parseTableText("😀".repeat(257))).toThrow("256文字");
  });
  it("reads color grids that fit the table", () => {
    expect(parseTableColors("#AABBCC\t\n\t#000000", 3, 2, "塗り")).toEqual([
      ["#aabbcc", undefined],
      [undefined, "#000000"],
      [undefined, undefined],
    ]);
    expect(parseTableColors("  ", 1, 1, "塗り")).toEqual([[undefined]]);
    expect(() => parseTableColors("red", 1, 1, "塗り")).toThrow(
      "塗りの1行1列「red」",
    );
    expect(() => parseTableColors("#000000\t\t#000000", 1, 2, "塗り")).toThrow(
      "列",
    );
    expect(() => parseTableColors("a\nb", 1, 1, "塗り")).toThrow("行");
  });
  it("pads and trims weights to the count", () => {
    expect(parseTableWeights("", 3, "列幅")).toEqual([1, 1, 1]);
    expect(parseTableWeights("2, 1", 3, "列幅")).toEqual([2, 1, 1]);
    expect(parseTableWeights("2 1 1 4", 2, "列幅")).toEqual([2, 1]);
    // 書き出しが指数表記になる小さな比も読み戻せる。
    expect(formatTableWeights([1e-7, 1])).toBe("1e-7, 1");
    expect(parseTableWeights("1e-7, 1E+2", 2, "列幅")).toEqual([1e-7, 100]);
    expect(() => parseTableWeights("0", 1, "列幅")).toThrow("列幅「0」");
    expect(() => parseTableWeights("-1", 1, "列幅")).toThrow();
    expect(() => parseTableWeights("1001", 1, "列幅")).toThrow();
  });
  it("round-trips through the input format", () => {
    const shape = cases[0].object.shape as TableShape;
    const texts = parseTableText(formatTableText(shape));
    const rows = texts.length,
      columns = texts[0].length;
    expect(
      buildTableCells(
        texts,
        parseTableColors(formatTableColors(shape, "fill"), rows, columns, ""),
        parseTableColors(formatTableColors(shape, "color"), rows, columns, ""),
      ),
    ).toEqual(shape.cells);
    expect(formatTableColors(shape, "fill")).toBe("#334155\t#334155\t#334155");
    expect(formatTableColors(shape, "color")).toBe("\n\t#22c55e");
    expect(formatTableWeights([1, 1])).toBe("");
    // 1列で最後の行が空の表も、行の数を保って戻る。
    for (const texts of [["A", "", ""], ["", ""], ["A", ""], [""]]) {
      const single = {
        ...shape,
        columns: [1],
        rows: texts.map(() => 1),
        cells: texts.map((text) => [{ text }]),
      };
      expect(parseTableText(formatTableText(single))).toEqual(
        texts.map((text) => [text]),
      );
    }
    expect(formatTableWeights([2, 1])).toBe("2, 1");
  });
});

describe("table editing", () => {
  const project = () => parseProject(JSON.stringify(sample));
  function added() {
    const next = applyCommand(
      project(),
      {
        type: "add",
        screenId: sample.screens[0].id,
        kind: "table",
      },
      "edit",
    );
    const object = next.screens[0].objects.at(-1)!;
    return { next, object };
  }
  it("adds a 3x3 table with a border and saves it", () => {
    const { next, object } = added();
    expect(object.shape.type).toBe("table");
    expect(object.shape).toMatchObject({
      columns: [1, 1, 1],
      rows: [1, 1, 1],
      border: { width: 1 },
    });
    expect(parseProject(serializeProject(next))).toEqual(next);
    expect(canFlip(object)).toBe(false);
  });
  it("applies the Inspector form and keeps the saved form minimal", () => {
    const { next, object } = added();
    const values = objectFormValues(object, false);
    const data = new Map(Object.entries(values));
    data.set("tableText", "工程\t開始\t完了\n搾汁\t08:00\t");
    data.set("tableColumns", "2");
    data.set("tableFills", "#334155\t#334155\t#334155");
    data.set("tableBorderMode", "none");
    data.set("tableBackgroundMode", "color");
    data.set("tableBackground", "#0f172a");
    const command = objectFormCommand(
      { get: (key) => data.get(key) ?? null, has: (key) => data.has(key) },
      { screenId: next.screens[0].id, definition: false, selected: object },
    );
    const after = applyCommand(next, command, "edit");
    const shape = after.screens[0].objects.find((o) => o.id === object.id)!
      .shape as TableShape;
    expect(shape).toEqual({
      type: "table",
      columns: [2, 1, 1],
      rows: [1, 1],
      cells: [
        [
          { text: "工程", fill: "#334155" },
          { text: "開始", fill: "#334155" },
          { text: "完了", fill: "#334155" },
        ],
        [{ text: "搾汁" }, { text: "08:00" }, { text: "" }],
      ],
      style: { fontSize: 14, fontWeight: "normal", align: "center" },
      background: "#0f172a",
    });
    expect(parseProject(serializeProject(after))).toEqual(after);
  });
  it("rejects a table patch on another shape and an inconsistent table", () => {
    const { next, object } = added();
    const text = next.screens[0].objects.find((o) => o.shape.type === "text")!;
    const table = structuredClone(object.shape as TableShape);
    const { type: _, ...content } = table;
    expect(() =>
      applyCommand(
        next,
        {
          type: "update",
          screenId: next.screens[0].id,
          objectId: text.id,
          patch: { table: content },
        },
        "edit",
      ),
    ).toThrow("表にだけ");
    expect(() =>
      applyCommand(
        next,
        {
          type: "update",
          screenId: next.screens[0].id,
          objectId: object.id,
          patch: { table: { ...content, rows: [1] } },
        },
        "edit",
      ),
    ).toThrow("セルの数");
  });
});
