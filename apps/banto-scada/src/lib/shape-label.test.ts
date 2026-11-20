import { describe, expect, it, vi } from "vitest";
import shapeLabelSample from "../../../../examples/shape-label.project.json";
import stateColorSample from "../../../../examples/state-color.project.json";
import minimal from "../../../../examples/minimal.project.json";
import { applyCommand } from "./editor";
import {
  isAreaShape,
  parseProject,
  serializeProject,
  type Project,
  type ScreenObject,
  type ShapeLabel,
  type ShapePaint,
} from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects } from "./clipboard";
import { AssetStore } from "./image-assets";
import { readProjectFile, writeProjectPackage } from "./project-package";
import {
  defaultShapeLabel,
  defaultShapeLabelColor,
  labelCanvasBackground,
  labelColorForLuminance,
  relativeLuminance,
  SHAPE_LABEL_DARK,
  SHAPE_LABEL_DEFAULT_STYLE,
  SHAPE_LABEL_LIGHT,
  SYMBOL_DEFINITION_BACKGROUND,
} from "./shape-label";
import {
  shapeLabelCommand,
  shapeLabelFormValues,
} from "./designer/forms/shape-label";

const solid = (color: string, alpha = 1, enabled = true): ShapePaint => ({
  fill: { enabled, paint: { type: "solid", color, alpha } },
  stroke: null,
});

describe("新しく作るときの文字色の既定（#305 L2）", () => {
  it("白・黒・中間色・暗い色は、見える塗りの色とのコントラスト比が大きい方", () => {
    expect(defaultShapeLabelColor(solid("#ffffff"), 1, "#000000")).toBe(
      SHAPE_LABEL_DARK,
    );
    expect(defaultShapeLabelColor(solid("#000000"), 1, "#ffffff")).toBe(
      SHAPE_LABEL_LIGHT,
    );
    expect(defaultShapeLabelColor(solid("#b0b0b0"), 1, "#000000")).toBe(
      "#0f172a",
    );
    expect(defaultShapeLabelColor(solid("#1e3a8a"), 1, "#ffffff")).toBe(
      "#ffffff",
    );
  });
  it("比が等しい境目は暗い色、境目を越えれば白", () => {
    const dark = relativeLuminance([15, 23, 42]);
    // (L + 0.05)^2 = 1.05 × (Ldark + 0.05) で 2 つの比が等しくなる。
    const tie = Math.sqrt(1.05 * (dark + 0.05)) - 0.05;
    expect(labelColorForLuminance(tie)).toBe(SHAPE_LABEL_DARK);
    expect(labelColorForLuminance(tie - 1e-6)).toBe(SHAPE_LABEL_LIGHT);
    expect(labelColorForLuminance(tie + 1e-6)).toBe(SHAPE_LABEL_DARK);
  });
  it("塗りの α と配置の opacity で背景に重ねた色で選ぶ", () => {
    // 白い背景に α 0.1 の黒はほぼ白に見える。
    expect(defaultShapeLabelColor(solid("#000000", 0.1), 1, "#ffffff")).toBe(
      SHAPE_LABEL_DARK,
    );
    expect(defaultShapeLabelColor(solid("#000000", 1), 0.1, "#ffffff")).toBe(
      SHAPE_LABEL_DARK,
    );
    expect(defaultShapeLabelColor(solid("#000000", 0.5), 0.2, "#ffffff")).toBe(
      SHAPE_LABEL_DARK,
    );
  });
  it("Symbol 定義では定義のキャンバスの背景に重ねる", () => {
    expect(SYMBOL_DEFINITION_BACKGROUND).toBe("#0b1220");
    const definition = { id: "d", name: "d", objects: [] } as never;
    expect(labelCanvasBackground(definition)).toBe("#0b1220");
    expect(labelCanvasBackground({ background: "#123456" } as never)).toBe(
      "#123456",
    );
    // 白の α 0.1 は暗い背景では暗く見える。
    expect(
      defaultShapeLabelColor(
        solid("#ffffff", 0.1),
        1,
        SYMBOL_DEFINITION_BACKGROUND,
      ),
    ).toBe(SHAPE_LABEL_LIGHT);
  });
  it("塗り無し・グラデーション・模様は canvasColors(背景).newText", () => {
    expect(
      defaultShapeLabelColor(solid("#000000", 1, false), 1, "#ffffff"),
    ).toBe("#0f172a");
    expect(
      defaultShapeLabelColor(solid("#ffffff", 1, false), 1, "#0b1220"),
    ).toBe("#2dd4bf");
    const gradient: ShapePaint = {
      fill: {
        enabled: true,
        paint: {
          type: "linearGradient",
          angle: 0,
          start: { color: "#000000", alpha: 1 },
          end: { color: "#000000", alpha: 1 },
        },
      },
      stroke: null,
    };
    expect(defaultShapeLabelColor(gradient, 1, "#0b1220")).toBe("#2dd4bf");
    const pattern: ShapePaint = {
      fill: {
        enabled: true,
        paint: {
          type: "pattern",
          kind: "hatch",
          spacing: 12,
          size: 1,
          angle: 45,
          foreground: { color: "#000000", alpha: 1 },
          background: null,
        },
      },
      stroke: null,
    };
    expect(defaultShapeLabelColor(pattern, 1, "#ffffff")).toBe("#0f172a");
  });
  it("書式の既定は 16・標準・中央・折返し word", () => {
    expect(SHAPE_LABEL_DEFAULT_STYLE).toEqual({
      fontSize: 16,
      fontWeight: "normal",
      align: "center",
      wrap: "word",
    });
  });
});

const fresh = () => parseProject(JSON.stringify(minimal));
const firstRectangle = (project: Project) =>
  project.screens[0].objects.find((o) => o.shape.type === "rectangle")!;
const label: ShapeLabel = {
  text: "工程\n1",
  style: { fontSize: 18, fontWeight: "bold", align: "left", wrap: "word" },
  color: "#ffffff",
};
const update = (
  project: Project,
  objectId: string,
  patch: Record<string, unknown>,
) => ({
  type: "update" as const,
  screenId: project.screens[0].id,
  objectId,
  patch,
});

describe("update の label（#305 L2）", () => {
  it("改行を正規化して入れ、null で消す。1 回の確定が 1 回の Undo", () => {
    const project = fresh(),
      target = firstRectangle(project);
    const result = recordEdit(
      project,
      emptyHistory(),
      update(project, target.id, { label: { ...label, text: "工程\r\n1" } }),
      "edit",
    );
    const saved = firstRectangle(result.project);
    expect(saved.shape).toMatchObject({ label });
    expect(result.history.past).toHaveLength(1);
    const removed = applyCommand(
      result.project,
      update(project, target.id, { label: null }),
      "edit",
    );
    expect("label" in firstRectangle(removed).shape).toBe(false);
    expect(
      travelHistory(result.project, result.history, "undo", "edit").project
        .screens,
    ).toEqual(project.screens);
  });
  it("同じ値は no-op、無い label の削除も no-op", () => {
    const project = applyCommand(
      fresh(),
      update(fresh(), firstRectangle(fresh()).id, { label }),
      "edit",
    );
    const id = firstRectangle(project).id;
    expect(applyCommand(project, update(project, id, { label }), "edit")).toBe(
      project,
    );
    const plain = fresh();
    expect(
      applyCommand(
        plain,
        update(plain, firstRectangle(plain).id, { label: null }),
        "edit",
      ),
    ).toBe(plain);
  });
  it("面の図形以外・不正な値は拒否し、Project を変えない", () => {
    const project = fresh(),
      before = serializeProject(project),
      id = firstRectangle(project).id;
    const other = project.screens[0].objects.find(
      (o) => o.shape.type !== "rectangle" && o.shape.type !== "ellipse",
    )!;
    expect(() =>
      applyCommand(project, update(project, other.id, { label }), "edit"),
    ).toThrow("矩形・楕円・多角形");
    for (const bad of [
      { ...label, text: "" },
      { ...label, text: "あ".repeat(1001) },
      { ...label, color: "#fff" },
      { ...label, style: { ...label.style, fontSize: 513 } },
      { ...label, style: { ...label.style, binding: {} } },
      { ...label, extra: 1 },
    ])
      expect(() =>
        applyCommand(project, update(project, id, { label: bad }), "edit"),
      ).toThrow();
    expect(
      applyCommand(
        project,
        update(project, id, { label: { ...label, text: "𠮷".repeat(1000) } }),
        "edit",
      ),
    ).not.toBe(project);
    expect(serializeProject(project)).toBe(before);
  });
  it("塗り・状態色の更新で label は消えない", () => {
    let project = fresh();
    const id = firstRectangle(project).id;
    project = applyCommand(project, update(project, id, { label }), "edit");
    project = applyCommand(
      project,
      update(project, id, { paint: solid("#123456") }),
      "edit",
    );
    expect(firstRectangle(project).shape).toMatchObject({ label });
    const definitionId = "0199f100-0000-7000-8000-000000001000",
      followerId = "0199f600-0000-7000-8000-000000000700";
    let symbolProject = parseProject(JSON.stringify(stateColorSample));
    const follow = (patch: Record<string, unknown>) =>
      applyCommand(
        symbolProject,
        {
          type: "update",
          screenId: definitionId,
          definitionId,
          objectId: followerId,
          patch,
        },
        "edit",
      );
    const follower = () =>
      symbolProject.symbols
        .find((s) => s.id === definitionId)!
        .objects.find((o) => o.id === followerId)!;
    const textId = (follower().shape as { stateColor: { textId: string } })
      .stateColor.textId;
    symbolProject = follow({ label });
    symbolProject = follow({ stateColor: null });
    expect(follower().shape).toMatchObject({ label });
    symbolProject = follow({ stateColor: { textId } });
    expect(follower().shape).toMatchObject({ label, stateColor: { textId } });
  });
});

describe("文字のフォーム（#305 L2）", () => {
  const context = (selected: ScreenObject | undefined, project: Project) => ({
    generation: 1,
    screenId: project.screens[0].id,
    definition: false,
    selected,
    background: "#ffffff",
  });
  const data = (values: Record<string, string>) => ({
    get: (name: string) => values[name] ?? null,
  });
  it("label が無い間は既定値を出し、文言と同じ確定で入る", () => {
    const project = fresh(),
      target = firstRectangle(project);
    const values = shapeLabelFormValues(target, "#ffffff");
    expect(values).toMatchObject({
      labelText: "",
      labelFontSize: "16",
      labelFontWeight: "normal",
      labelAlign: "center",
      labelWrap: "word",
      labelColor: defaultShapeLabel(target, "#ffffff").color,
    });
    const command = shapeLabelCommand(
      {
        data: data({ ...values, labelText: "ポンプ 室" }),
        objectId: target.id,
        targetKey: `1:${project.screens[0].id}:false`,
      },
      context(target, project),
    );
    expect(command).toMatchObject({
      patch: {
        label: {
          text: "ポンプ\n室",
          style: SHAPE_LABEL_DEFAULT_STYLE,
          color: values.labelColor,
        },
      },
    });
  });
  it("新しい label で色を触っていなければ、確定時の塗りで既定の色を選び直す（塗りと一括適用）", () => {
    const project = fresh(),
      target = firstRectangle(project);
    if (!isAreaShape(target.shape)) throw new Error("rectangle expected");
    target.shape.paint = solid("#ffffff");
    const shown = shapeLabelFormValues(target, "#ffffff");
    expect(shown.labelColor).toBe(SHAPE_LABEL_DARK);
    expect(shown.labelColorAuto).toBe("1");
    // 同じ一括適用で塗りが先に黒へ変わった後に、文字のフォームが送られる。
    target.shape.paint = solid("#000000");
    const input = (values: Record<string, string>) => ({
      data: data({ ...shown, labelText: "工程", ...values }),
      objectId: target.id,
      targetKey: `1:${project.screens[0].id}:false`,
    });
    expect(
      shapeLabelCommand(input({}), context(target, project)),
    ).toMatchObject({ patch: { label: { color: SHAPE_LABEL_LIGHT } } });
    // 色の欄を触った（labelColorAuto が空）なら、指定の色のまま。
    expect(
      shapeLabelCommand(
        input({ labelColorAuto: "", labelColor: SHAPE_LABEL_DARK }),
        context(target, project),
      ),
    ).toMatchObject({ patch: { label: { color: SHAPE_LABEL_DARK } } });
  });
  it("文言を空にすると null、適用先が変わっていれば拒否", () => {
    const project = fresh(),
      target = firstRectangle(project),
      input = {
        data: data({ labelText: "", labelFontSize: "x" }),
        objectId: target.id,
        targetKey: `1:${project.screens[0].id}:false`,
      };
    expect(shapeLabelCommand(input, context(target, project))).toMatchObject({
      patch: { label: null },
    });
    expect(() =>
      shapeLabelCommand(
        { ...input, objectId: "another" },
        context(target, project),
      ),
    ).toThrow("選択し直して");
    expect(() =>
      shapeLabelCommand(
        { ...input, data: data({ labelText: "a", labelFontSize: "0" }) },
        context(target, project),
      ),
    ).toThrow("文字サイズ");
  });
  it("保存で wrap を省いた label・大文字の色は、変えずに適用すれば no-op", () => {
    let project = fresh();
    const id = firstRectangle(project).id;
    const legacy = {
      text: "A",
      style: { fontSize: 12, fontWeight: "normal", align: "center" },
      color: "#ABCDEF",
    };
    project = applyCommand(
      project,
      update(project, id, { label: legacy }),
      "edit",
    );
    const target = firstRectangle(project);
    const command = shapeLabelCommand(
      {
        data: data(shapeLabelFormValues(target, "#ffffff")),
        objectId: id,
        targetKey: `1:${project.screens[0].id}:false`,
      },
      context(target, project),
    );
    expect(applyCommand(project, command, "edit")).toBe(project);
  });
});

describe("label の往復（#305 L2）", () => {
  const sample = () => parseProject(JSON.stringify(shapeLabelSample));
  const labelled = (project: Project) =>
    project.screens[0].objects.filter(
      (o) => "label" in o.shape && typeof o.shape.label === "object",
    );
  const labels = (objects: ScreenObject[]) =>
    objects.map((o) => (o.shape as { label: ShapeLabel }).label);
  it("複製・配列複製で label を持ち運ぶ", () => {
    const project = sample(),
      source = labelled(project);
    const duplicated = applyCommand(
      project,
      {
        type: "duplicate",
        screenId: project.screens[0].id,
        objectId: source[0].id,
      },
      "edit",
    );
    expect(labels(labelled(duplicated)).at(-1)).toEqual(labels(source)[0]);
    const arrayed = applyCommand(
      project,
      {
        type: "duplicate-array",
        screenId: project.screens[0].id,
        objectIds: source.map((o) => o.id),
        columns: 2,
        rows: 1,
        stepX: 10,
        stepY: 0,
      },
      "edit",
    );
    expect(labels(labelled(arrayed))).toEqual([
      ...labels(source),
      ...labels(source),
    ]);
  });
  it("コピー・貼付け（同じ／別の Project）で label を持ち運ぶ", () => {
    const project = sample(),
      source = labelled(project),
      text = copyObjects(
        project,
        project.screens[0].id,
        source.map((o) => o.id),
        "workspace-a",
      );
    for (const [target, origin] of [
      [project, "workspace-a"],
      [fresh(), "workspace-b"],
    ] as const) {
      const pasted = applyCommand(
        target,
        {
          type: "paste",
          screenId: target.screens[0].id,
          text,
          origin,
          center: { x: 300, y: 200 },
        },
        "edit",
      );
      expect(labels(labelled(pasted)).slice(-source.length)).toEqual(
        labels(source),
      );
    }
  });
  it("JSON と package の往復で文字と書式が変わらない", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1, height: 1, close() {} })),
    );
    const project = sample();
    expect(parseProject(serializeProject(project))).toEqual(project);
    const store = new AssetStore();
    try {
      const blob = await writeProjectPackage(project, store);
      const opened = await readProjectFile(blob);
      try {
        expect(opened.project).toEqual(project);
      } finally {
        opened.store.dispose();
      }
    } finally {
      store.dispose();
      vi.unstubAllGlobals();
    }
  });
});
