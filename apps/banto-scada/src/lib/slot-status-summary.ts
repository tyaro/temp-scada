import type { Screen, SymbolDefinition } from "./project";
import { placementLabel } from "./placement-label";
import {
  resolveSymbolSlot,
  type EquipmentContext,
  type SlotPresentation,
} from "./symbol-slots";
import { isSimulatedSlot } from "./slot-presentation";

export interface SlotStatusRow {
  key: string;
  path: string[];
  equipment: string;
  slotName: string;
  display: SlotPresentation;
  simulated: boolean;
}
/** Used roles are references even when the authored Text is hidden or transparent. */
function usedSlots(definition: SymbolDefinition): string[] {
  return [
    ...new Set(
      definition.objects.flatMap((object) =>
        object.shape.type === "text" && object.shape.slotBinding
          ? [object.shape.slotBinding.slotName]
          : [],
      ),
    ),
  ];
}

/** Drawing scope only: visible placement paths and the existing one-level View contract. */
export function slotStatusRows(
  screen: Screen | SymbolDefinition,
  screens: readonly Screen[],
  symbols: readonly SymbolDefinition[],
  context?: EquipmentContext,
): SlotStatusRow[] {
  const result: SlotStatusRow[] = [];
  const symbolList = [...symbols];
  const definitions = new Map(
    symbols.map((definition) => [definition.id, definition]),
  );
  const sources = new Map(screens.map((source) => [source.id, source]));
  function add(
    definition: SymbolDefinition,
    ids: string[],
    path: string[],
    equipmentId?: string,
  ) {
    const equipment = context?.equipment?.find(
      (item) => item.id === equipmentId,
    );
    for (const slotName of usedSlots(definition)) {
      const display = resolveSymbolSlot(
        definition,
        slotName,
        equipmentId,
        context,
      );
      result.push({
        key: JSON.stringify([...ids, slotName]),
        path,
        equipment: equipment
          ? `${equipment.code} · ${equipment.name}`
          : "機器未関連付け",
        slotName,
        display,
        simulated: isSimulatedSlot(display.provenance),
      });
    }
  }
  function visit(
    owner: Screen,
    ids: string[],
    path: string[],
    allowView: boolean,
  ) {
    for (const object of [...owner.objects].sort((a, b) => a.order - b.order)) {
      if (object.visible === false) continue;
      if (object.shape.type === "symbol") {
        const definition = definitions.get(object.shape.symbolId);
        if (definition)
          add(
            definition,
            [...ids, object.id],
            [...path, placementLabel(object, symbolList)],
            object.shape.equipmentId,
          );
      } else if (allowView && object.shape.type === "screenView") {
        const source = sources.get(object.shape.screenId);
        if (source)
          visit(
            source,
            [...ids, object.id, source.id],
            [...path, `${placementLabel(object)} / ${source.name}`],
            false,
          );
      }
    }
  }
  if ("background" in screen) visit(screen, [screen.id], [screen.name], true);
  else add(screen, [screen.id], [`共有定義 / ${screen.name}`]);
  return result;
}
export function slotStatusCounts(rows: readonly SlotStatusRow[]) {
  return {
    total: rows.length,
    unavailable: rows.filter((row) => row.display.state !== "good").length,
    simulated: rows.filter((row) => row.simulated).length,
  };
}
