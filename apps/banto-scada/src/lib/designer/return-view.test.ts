import { expect, it } from "vitest";
import sample from "../../../../../examples/process.project.json";
import { parseProject } from "../project";
import { rememberReturnView, restoredSelection } from "./return-view";

const screen = () => parseProject(JSON.stringify(sample)).screens[0];
const PUMP = "0199f200-0000-7000-8000-000000000020";
const VALVE = "0199f200-0000-7000-8000-000000000021";
const TEXT = "0199f200-0000-7000-8000-000000000010";
const PUMP_DEFINITION = "0199f100-0000-7000-8000-000000001000";

it("remembers each screen separately and copies the view", () => {
  const center = { x: 10, y: 20 };
  const selectedIds = [PUMP];
  const first = rememberReturnView({}, "a", { selectedIds, zoom: 2, center });
  const both = rememberReturnView(first, "b", {
    selectedIds: [],
    zoom: null,
    center: { x: 1, y: 1 },
  });
  center.x = 99;
  selectedIds.push(TEXT);
  expect(both).toEqual({
    a: { selectedIds: [PUMP], zoom: 2, center: { x: 10, y: 20 } },
    // fit 表示は表示中心を持たない。
    b: { selectedIds: [], zoom: null, center: null },
  });
  expect(first).not.toHaveProperty("b");
});

it("restores only placements that still exist, in layer order", () => {
  expect(restoredSelection(screen(), [VALVE, "deleted", TEXT])).toEqual([
    TEXT,
    VALVE,
  ]);
  expect(restoredSelection(screen(), ["deleted"])).toEqual([]);
  expect(restoredSelection(screen(), [])).toEqual([]);
});

it("selects the entry placement when returning from its definition", () => {
  expect(restoredSelection(screen(), [TEXT, PUMP], PUMP_DEFINITION)).toEqual([
    PUMP,
  ]);
  // 定義を参照する配置が選択になければ、保存した選択をそのまま戻す。
  expect(restoredSelection(screen(), [TEXT, VALVE], PUMP_DEFINITION)).toEqual([
    TEXT,
    VALVE,
  ]);
  // 入口の配置が削除されていれば、残りを戻す。
  const owner = screen();
  owner.objects = owner.objects.filter((object) => object.id !== PUMP);
  expect(restoredSelection(owner, [TEXT, PUMP], PUMP_DEFINITION)).toEqual([
    TEXT,
  ]);
});

it("completes geometric groups", () => {
  const owner = screen();
  owner.groups = [{ id: "g", name: "設備", memberIds: [PUMP, VALVE] }];
  expect(restoredSelection(owner, [PUMP])).toEqual([PUMP, VALVE]);
});
