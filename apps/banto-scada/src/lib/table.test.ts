import { describe, expect, it } from "vitest";
import sample from "../../../../examples/read-presentation.project.json";
import cases from "../../../../examples/table-cases.json";
import { parseProject, serializeProject, type TableShape } from "./project";
import { applyCommand, type EditCommand } from "./editor";
import {
  buildTableCells,
  formatTableColors,
  formatTableFormats,
  formatTableSlots,
  formatTableTags,
  formatTableText,
  formatTableUnknownColors,
  formatTableWeights,
  parseTableColors,
  parseTableFormats,
  parseTableSlots,
  parseTableTags,
  parseTableText,
  parseTableWeights,
  tableCellBoxes,
  tableEdges,
} from "./table";
import { objectFormCommand } from "./designer/forms/object-form";
import { objectFormValues } from "./designer/numeric-properties";
import { canFlip } from "./flip";
import { shapeSlotNames, shapeTagBindings } from "./shape-bindings";
import { symbolSlotUsages } from "./symbol-slots";
import { slotStatusRows } from "./slot-status-summary";
import { bindingReferences } from "./binding-references";
import {
  applyBindingReplacement,
  previewBindingReplacement,
} from "./binding-replacement";
import { copyObjects } from "./clipboard";

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

describe("table cell bindings", () => {
  const boundCase = cases.find(
    (c) => c.name === "screen table with bound cells and formats",
  )!;
  const boundShape = boundCase.object.shape as TableShape;
  function withBoundTable() {
    const value = structuredClone(sample);
    value.screens[0].objects.push(structuredClone(boundCase.object) as any);
    return parseProject(JSON.stringify(value));
  }
  it("reads and writes the tag and format grids", () => {
    expect(formatTableTags(boundShape)).toBe("\tDemo.Number\n\tDemo.Other");
    expect(formatTableFormats(boundShape)).toBe("\t1;℃");
    expect(parseTableTags("   \tDemo.Number\n", 2, 2)).toEqual([
      [undefined, { externalName: "Demo.Number" }],
      [undefined, undefined],
    ]);
    expect(parseTableFormats("1;℃\t2;\t;kg\t;m 3", 1, 4)).toEqual([
      [
        { decimals: 1, unit: "℃" },
        { decimals: 2 },
        { unit: "kg" },
        { unit: "m 3" },
      ],
    ]);
    expect(parseTableFormats(" 1 ; ℃ ", 1, 1)).toEqual([
      [{ decimals: 1, unit: "℃" }],
    ]);
    const texts = parseTableText(formatTableText(boundShape));
    const [rows, columns] = [texts.length, texts[0].length];
    expect(
      buildTableCells(
        texts,
        [],
        [],
        parseTableTags(formatTableTags(boundShape), rows, columns),
        parseTableFormats(formatTableFormats(boundShape), rows, columns),
      ),
    ).toEqual(boundShape.cells);
  });
  it("round-trips ambiguous units, spaces in tags and semicolons", () => {
    const units = ["1", "1 ℃", "10 kPa", "a;b", "℃"];
    for (const unit of units) {
      for (const decimals of [undefined, 0, 3]) {
        const format = {
          ...(decimals === undefined ? {} : { decimals }),
          unit,
        };
        const shape = {
          ...boundShape,
          rows: [1],
          columns: [1],
          cells: [[{ text: "", binding: { externalName: "A" }, format }]],
        } as TableShape;
        const text = formatTableFormats(shape);
        expect(text).toBe(`${decimals ?? ""};${unit}`);
        expect(parseTableFormats(text, 1, 1)).toEqual([[format]]);
      }
    }
    const decimalsOnly = { decimals: 2 };
    const only = {
      ...boundShape,
      rows: [1],
      columns: [1],
      cells: [
        [{ text: "", binding: { externalName: "A" }, format: decimalsOnly }],
      ],
    } as TableShape;
    expect(formatTableFormats(only)).toBe("2;");
    expect(parseTableFormats("2;", 1, 1)).toEqual([[decimalsOnly]]);
    const spaced = {
      ...boundShape,
      rows: [1],
      columns: [1],
      cells: [[{ text: "", binding: { externalName: " PLC1.Temp " } }]],
    } as TableShape;
    expect(formatTableTags(spaced)).toBe(" PLC1.Temp ");
    expect(parseTableTags(formatTableTags(spaced), 1, 1)).toEqual([
      [{ externalName: " PLC1.Temp " }],
    ]);
  });
  it("rejects a format without a tag, bad formats and grids larger than the table", () => {
    expect(() =>
      buildTableCells([["a"]], [], [], [], [[{ decimals: 1 }]]),
    ).toThrow("タグのないセル");
    expect(() => parseTableFormats("7;℃", 1, 1)).toThrow("0〜6");
    expect(() => parseTableFormats("a;℃", 1, 1)).toThrow("0〜6");
    expect(() => parseTableFormats("1 ℃", 1, 1)).toThrow("小数桁;単位");
    expect(() => parseTableFormats("1;" + "x".repeat(17), 1, 1)).toThrow(
      "16文字",
    );
    expect(() => parseTableTags("a\tb", 1, 1)).toThrow("列が表の列");
    expect(() => parseTableFormats("1;\n1;", 1, 1)).toThrow("行が表の行");
    expect(() => parseTableTags("x".repeat(1025), 1, 1)).toThrow("1024文字");
  });
  it("lists every bound cell as a tag binding", () => {
    expect(shapeTagBindings(boundShape)).toEqual([
      { externalName: "Demo.Number" },
      { externalName: "Demo.Other" },
    ]);
    const same = structuredClone(boundShape);
    same.cells[1][1].binding = { externalName: "Demo.Number" };
    expect(shapeTagBindings(same)).toHaveLength(2);
    const project = withBoundTable();
    project.screens[0].objects.at(-1)!.shape = same;
    const usages = bindingReferences(project)
      .find((ref) => ref.externalName === "Demo.Number")!
      .usages.filter((usage) => usage.objectId === boundCase.object.id);
    // 同じタグを読む2つのセルは、参照一覧では1つの配置にまとめる。
    expect(usages).toHaveLength(1);
  });
  it("renames the tag of every matching cell", () => {
    const project = withBoundTable();
    const request = {
      from: "Demo.Other",
      to: "Demo.Renamed",
      expectedProject: serializeProject(project),
    };
    const preview = previewBindingReplacement(
      project,
      request.from,
      request.to,
    );
    expect(preview.usages.map((usage) => usage.objectId)).toContain(
      boundCase.object.id,
    );
    applyBindingReplacement(project, request);
    const shape = project.screens[0].objects.at(-1)!.shape as TableShape;
    expect(shape.cells[1][1].binding).toEqual({ externalName: "Demo.Renamed" });
    expect(shape.cells[0][1].binding).toEqual({ externalName: "Demo.Number" });
  });
  it("applies the tag and format grids from the Inspector form on a screen only", () => {
    const project = withBoundTable();
    const object = project.screens[0].objects.at(-1)!;
    const values = objectFormValues(object, false);
    expect(values.tableTags).toBe("\tDemo.Number\n\tDemo.Other");
    expect(values.tableFormats).toBe("\t1;℃");
    const data = new Map(Object.entries(values));
    data.set("tableTags", "\tDemo.Number");
    data.set("tableFormats", "\t2;kPa");
    const form = {
      get: (key: string) => data.get(key) ?? null,
      has: (key: string) => data.has(key),
    };
    const after = applyCommand(
      project,
      objectFormCommand(form, {
        screenId: project.screens[0].id,
        definition: false,
        selected: object,
      }),
      "edit",
    );
    const shape = after.screens[0].objects.at(-1)!.shape as TableShape;
    expect(shape.cells).toEqual([
      [
        { text: "温度" },
        {
          text: "--",
          binding: { externalName: "Demo.Number" },
          format: { decimals: 2, unit: "kPa" },
        },
      ],
      [{ text: "流量" }, { text: "" }],
    ]);
    data.set("tableFormats", "1;");
    expect(() =>
      objectFormCommand(form, {
        screenId: project.screens[0].id,
        definition: false,
        selected: object,
      }),
    ).toThrow("タグのないセル");
    // Symbol 定義の編集では、セルのタグの欄を読まない。
    data.set("tableFormats", "");
    const definition = objectFormCommand(form, {
      screenId: project.symbols[0].id,
      definition: true,
      selected: object,
    });
    expect(
      definition.type === "update" &&
        definition.patch.table?.cells.flat().some((cell) => cell.binding),
    ).toBe(false);
  });
  it("rejects pasting a bound table into a Symbol definition", () => {
    const project = withBoundTable();
    const text = copyObjects(
      project,
      project.screens[0].id,
      [boundCase.object.id],
      "test",
    );
    expect(() =>
      applyCommand(
        project,
        {
          type: "paste",
          screenId: project.screens[0].id,
          definitionId: project.symbols[0].id,
          text,
          origin: "test",
          center: { x: 50, y: 50 },
        },
        "edit",
      ),
    ).toThrow("タグ付きのText・液位・表");
    const pasted = applyCommand(
      project,
      {
        type: "paste",
        screenId: project.screens[0].id,
        text,
        origin: "test",
        center: { x: 50, y: 50 },
      },
      "edit",
    );
    expect(pasted.screens[0].objects).toHaveLength(
      project.screens[0].objects.length + 1,
    );
  });
});

describe("table cell slots", () => {
  const slotCase = cases.find(
    (c) => c.name === "symbol table with slot cells, format and state colors",
  )!;
  const slotShape = slotCase.object.shape as TableShape;
  function withSlotTable() {
    const value = structuredClone(sample);
    value.symbols[0].objects.push(structuredClone(slotCase.object) as any);
    return parseProject(JSON.stringify(value));
  }
  it("lists the slots of every bound cell", () => {
    expect(shapeSlotNames(slotShape)).toEqual(["running", "current"]);
    const project = withSlotTable();
    const definition = project.symbols[0];
    expect(
      symbolSlotUsages(definition, "current").map((object) => object.id),
    ).toContain(slotCase.object.id);
  });
  it("keeps a slot used only by a table cell from being removed", () => {
    const value = structuredClone(sample);
    // 表だけが current を読む Symbol 定義にする。
    value.symbols[0].objects = value.symbols[0].objects.filter(
      (object: any) => object.shape.slotBinding?.slotName !== "current",
    );
    value.symbols[0].objects.push(structuredClone(slotCase.object) as any);
    const project = parseProject(JSON.stringify(value));
    expect(() =>
      applyCommand(
        project,
        {
          type: "remove-symbol-slot",
          symbolId: project.symbols[0].id,
          slotName: "current",
        },
        "edit",
      ),
    ).toThrow("表で使用中");
  });
  it("lists a slot read only by a table cell in the slot status", () => {
    const value = structuredClone(sample);
    value.symbols[0].objects = value.symbols[0].objects.filter(
      (object: any) => object.shape.slotBinding?.slotName !== "current",
    );
    value.symbols[0].objects.push(structuredClone(slotCase.object) as any);
    const project = parseProject(JSON.stringify(value));
    const rows = slotStatusRows(
      project.symbols[0],
      project.screens,
      project.symbols,
    );
    expect(rows.map((row) => row.slotName)).toContain("current");
  });
  it("reads and writes the slot and unknown color grids", () => {
    expect(formatTableSlots(slotShape)).toBe("\trunning\n\tcurrent");
    expect(formatTableUnknownColors(slotShape)).toBe("\t#64748b");
    expect(formatTableFormats(slotShape)).toBe("\n\t1;A");
    expect(parseTableSlots(" running \t", 1, 2, ["running"])).toEqual([
      [{ slotName: "running" }, undefined],
    ]);
    expect(() => parseTableSlots("missing", 1, 1, ["running"])).toThrow(
      "宣言済みの読取slotではありません",
    );
  });
  it("applies the slot grids from the Inspector form in a Symbol definition", () => {
    const project = withSlotTable();
    const definition = project.symbols[0];
    const object = definition.objects.at(-1)!;
    const values = objectFormValues(object, true);
    const data = new Map(Object.entries(values));
    const form = {
      get: (key: string) => data.get(key) ?? null,
      has: (key: string) => data.has(key),
    };
    const context = {
      screenId: project.screens[0].id,
      definition: true,
      readSlots: definition.readSlots,
      selected: object,
    };
    const after = applyCommand(
      project,
      {
        ...objectFormCommand(form, context),
        definitionId: definition.id,
      } as EditCommand,
      "edit",
    );
    expect(
      (after.symbols[0].objects.at(-1)!.shape as TableShape).cells,
    ).toEqual(slotShape.cells);
    data.set("tableSlots", "\trunning\n\tmissing");
    expect(() => objectFormCommand(form, context)).toThrow(
      "宣言済みの読取slotではありません",
    );
    data.set("tableSlots", "\trunning\n\tcurrent");
    data.set("tableUnknownColors", "\t#64748b\n\t#64748b");
    expect(() => objectFormCommand(form, context)).toThrow(
      "boolかstateのslotのセルではありません",
    );
    data.set("tableUnknownColors", "#64748b");
    expect(() => objectFormCommand(form, context)).toThrow(
      "boolかstateのslotのセルではありません",
    );
    data.set("tableUnknownColors", "");
    data.set("tableFormats", "1;A");
    expect(() => objectFormCommand(form, context)).toThrow("slotのないセル");
  });
  it("rejects copying a table with slot cells on its own", () => {
    const project = withSlotTable();
    expect(() =>
      copyObjects(project, project.symbols[0].id, [slotCase.object.id], "test"),
    ).toThrow("slot表示単体");
  });
});
