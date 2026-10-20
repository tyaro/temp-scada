import { expect, it } from "vitest";
import { groupNameFormCommand } from "./group-name";
it("binds deferred group names to the same generation, screen and group", () => {
  const data = new FormData();
  data.set("name", " 新しい設備 ");
  const context = { generation: 2, screenId: "screen", groupId: "group" };
  const input = { data, targetKey: "2:screen", groupId: "group" };
  expect(groupNameFormCommand(input, context)).toEqual({
    type: "rename-group",
    screenId: "screen",
    groupId: "group",
    name: "新しい設備",
  });
  expect(() =>
    groupNameFormCommand(input, { ...context, generation: 3 }),
  ).toThrow();
  expect(() =>
    groupNameFormCommand(input, { ...context, screenId: "other" }),
  ).toThrow();
  expect(() =>
    groupNameFormCommand(input, { ...context, groupId: "other" }),
  ).toThrow();
  data.set("name", "  ");
  expect(groupNameFormCommand(input, context)).toHaveProperty(
    "name",
    undefined,
  );
});
