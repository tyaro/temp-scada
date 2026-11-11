import { expect, it } from "vitest";
import { render } from "svelte/server";
import sample from "../../../../examples/read-presentation.project.json";
import { parseProject } from "./project";
import { previewEquipmentLink } from "./equipment-read-details";
import Renderer from "./Renderer.svelte";

// UX精査 F-2: 表示プレビューで機器を関連付けた Symbol から読取詳細の小窓を開く入口。
const project = parseProject(JSON.stringify(sample));
const screen = project.screens[0];
const [pump] = project.equipment!;
const context = {
  equipmentTypes: project.equipmentTypes,
  equipment: project.equipment,
};

it("links only Symbols whose equipment exists", () => {
  const shapes = screen.objects.map((object) => object.shape);
  const linked = shapes.filter((shape) =>
    previewEquipmentLink(shape, project.equipment),
  );
  expect(linked).toHaveLength(2);
  expect(
    previewEquipmentLink(
      { type: "symbol", equipmentId: pump.id },
      project.equipment,
    ),
  ).toBe(pump);
  expect(previewEquipmentLink({ type: "symbol" }, project.equipment)).toBe(
    undefined,
  );
  expect(
    previewEquipmentLink(
      { type: "symbol", equipmentId: "missing" },
      project.equipment,
    ),
  ).toBe(undefined);
  expect(previewEquipmentLink({ type: "text", equipmentId: pump.id }, [])).toBe(
    undefined,
  );
});

function markup(props: { editable: boolean; open: boolean }) {
  return render(Renderer, {
    props: {
      screen,
      symbols: project.symbols,
      screens: project.screens,
      equipmentContext: context,
      editable: props.editable,
      onopenequipment: props.open ? () => {} : undefined,
    },
  }).body;
}

it("preview renders linked Symbols as buttons with the equipment code as hover title", () => {
  const body = markup({ editable: false, open: true });
  expect(body.match(/data-equipment-link=/g)).toHaveLength(2);
  expect(body).toContain(
    `aria-label="${pump.code} ${pump.name}の読取詳細を開く"`,
  );
  expect(body).toContain(`<title>${pump.code} ${pump.name}</title>`);
  expect(body).toContain('class="equipment-hit');
});

it("edit mode and a missing opener leave Symbols without the entry", () => {
  for (const props of [
    { editable: true, open: true },
    { editable: false, open: false },
  ]) {
    const body = markup(props);
    expect(body).not.toContain("data-equipment-link=");
    expect(body).not.toContain("の読取詳細を開く");
  }
});
