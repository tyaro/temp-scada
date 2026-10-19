import { expect, it } from "vitest";
import { render } from "svelte/server";
import sample from "../../../../examples/process.project.json";
import cases from "../../../../examples/line-style-cases.json";
import { parseProject, getBounds } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { lineDash, lineCap } from "./line-style";
import Primitive from "./Primitive.svelte";
it("shares line style enums and optional solid across all screen/definition lines and outlines with Rust", () => {
  for (const owner of ["screens", "symbols"] as const)
    for (let i = 0; i < sample[owner][0].objects.length; i++) {
      const original = sample[owner][0].objects[i];
      if (!["rectangle", "ellipse", "polyline"].includes(original.shape.type))
        continue;
      for (const entry of cases) {
        const project: any = structuredClone(sample),
          shape = project[owner][0].objects[i].shape,
          target =
            shape.type === "polyline"
              ? shape
              : (shape.paint.stroke ??= { color: "#334155", width: 4 });
        if ("missing" in entry) delete target.lineStyle;
        else target.lineStyle = entry.value;
        if (entry.valid)
          expect(parseProject(JSON.stringify(project))).toEqual(project);
        else expect(() => parseProject(JSON.stringify(project))).toThrow();
      }
    }
  const old: any = structuredClone(sample);
  old.manifest.schemaVersion = old.manifest.minRuntimeVersion = "0.12.0";
  expect(() => parseProject(JSON.stringify(old))).toThrow();
});
it("keeps geometry and bounds, changes width-scaled dashes and leaves arrowhead solid", () => {
  const project = parseProject(JSON.stringify(sample)),
    object = project.screens[0].objects.find(
      (o) => o.shape.type === "polyline",
    )!;
  const original = getBounds(object);
  for (const style of ["solid", "dashed", "dotted"] as const) {
    const next = applyCommand(
        project,
        {
          type: "update",
          screenId: project.screens[0].id,
          objectId: object.id,
          patch: { lineStyle: style, strokeWidth: 4, arrow: "end" },
        },
        "edit",
      ),
      painted = next.screens[0].objects.find((o) => o.id === object.id)!;
    const svg = render(Primitive, { props: { object: painted } }).body;
    if (style === "solid") expect(svg).not.toContain("stroke-dasharray");
    else
      expect(svg).toContain(
        `stroke-dasharray="${style === "dashed" ? "16 8" : "0 8"}"`,
      );
    expect(svg).toContain(`stroke-linecap="${lineCap(style)}"`);
    expect(svg.match(/<polygon[^>]*>/)?.[0]).not.toContain("dash");
    expect(
      getBounds({
        ...painted,
        shape: {
          ...painted.shape,
          strokeWidth: (object.shape as any).strokeWidth,
          arrow: (object.shape as any).arrow,
        },
      } as any),
    ).toEqual(original);
  }
  expect(lineDash("dashed", 2)).toBe("8 4");
  expect(lineDash("dotted", 64)).toBe("0 128");
});
it("bulk line changes are atomic, no-op default solid adds no history and width-only keeps style", () => {
  const project = parseProject(JSON.stringify(sample)),
    owner = project.screens[0],
    ids = owner.objects
      .filter((o) => o.shape.type === "polyline")
      .map((o) => o.id);
  const command = {
    type: "set-line-style" as const,
    screenId: owner.id,
    objectIds: ids,
    patch: { lineStyle: "solid" as const },
  };
  expect(recordEdit(project, emptyHistory(), command, "edit").project).toBe(
    project,
  );
  const changed = recordEdit(
    project,
    emptyHistory(),
    { ...command, patch: { lineStyle: "dotted" } },
    "edit",
  );
  expect(
    changed.project.screens[0].objects
      .filter((o) => ids.includes(o.id))
      .every((o) => (o.shape as any).lineStyle === "dotted"),
  ).toBe(true);
  expect(
    travelHistory(changed.project, changed.history, "undo", "edit").project
      .screens,
  ).toEqual(project.screens);
  const resized = applyCommand(
    changed.project,
    { ...command, patch: { strokeWidth: 9 } as any },
    "edit",
  );
  expect(
    resized.screens[0].objects
      .filter((o) => ids.includes(o.id))
      .every((o) => (o.shape as any).lineStyle === "dotted"),
  ).toBe(true);
  for (const value of ["bad", null, 1])
    expect(() =>
      applyCommand(
        project,
        { ...command, patch: { lineStyle: value } as any },
        "edit",
      ),
    ).toThrow();
  owner.objects.find((o) => o.id === ids[0])!.locked = true;
  expect(() =>
    applyCommand(
      project,
      { ...command, patch: { lineStyle: "dashed" } },
      "edit",
    ),
  ).toThrow(/ロック/);
});
it("bulk outline style preserves unspecified paint and requires explicit creation and consistent removal", () => {
  const project = parseProject(JSON.stringify(sample)),
    owner = project.screens[0],
    ids = owner.objects
      .filter((o) => o.shape.type === "rectangle")
      .slice(0, 2)
      .map((o) => o.id);
  const command = {
    type: "set-outline-style" as const,
    screenId: owner.id,
    objectIds: ids,
    patch: { lineStyle: "dashed" as const },
  };
  expect(() => applyCommand(project, command, "edit")).toThrow(/枠線なし/);
  const next = applyCommand(
    project,
    {
      ...command,
      patch: { ...command.patch, mode: "enabled", color: "#334155", width: 4 },
    },
    "edit",
  );
  for (const id of ids) {
    const original = owner.objects.find((o) => o.id === id)!,
      changed = next.screens[0].objects.find((o) => o.id === id)!;
    expect(changed).toEqual({
      ...original,
      shape: {
        ...original.shape,
        paint: {
          ...(original.shape as any).paint,
          stroke: { color: "#334155", width: 4, lineStyle: "dashed" },
        },
      },
    });
  }
  expect(() =>
    applyCommand(
      next,
      { ...command, patch: { lineStyle: "solid", mode: "none" } },
      "edit",
    ),
  ).toThrow(/同時/);
  const width = applyCommand(next, { ...command, patch: { width: 8 } }, "edit");
  expect(
    (width.screens[0].objects.find((o) => o.id === ids[0])!.shape as any).paint
      .stroke.lineStyle,
  ).toBe("dashed");
  const solid = applyCommand(
    next,
    { ...command, patch: { lineStyle: "solid" } },
    "edit",
  );
  expect(
    (solid.screens[0].objects.find((o) => o.id === ids[0])!.shape as any).paint
      .stroke,
  ).toEqual({ color: "#334155", width: 4 });
});
