import { describe, expect, it } from "vitest";
import {
  availableFavorites,
  DEFAULT_FAVORITES,
  favoriteKey,
  parseFavorites,
} from "./favorites";
import type { SymbolDefinition } from "../project";
const projectA = "019b0000-0000-7000-8000-000000000001";
const projectB = "019b0000-0000-7000-8000-000000000002";
const definition: SymbolDefinition = {
  id: "019b0000-0000-7000-8000-000000000003",
  name: "ポンプA",
  width: 100,
  height: 100,
  objects: [],
};
describe("favorite UI preferences", () => {
  it("keeps empty preferences, deduplicates and filters unknown data, and bounds corrupted preferences", () => {
    expect(parseFavorites("[]")).toEqual([]);
    expect(
      parseFavorites(
        JSON.stringify([
          "basic:text",
          "basic:text",
          null,
          { type: "basic" },
          "builtin:pump",
          "basic:bad",
          "symbol:bad:bad",
        ]),
      ),
    ).toEqual(["basic:text", "builtin:pump"]);
    for (const raw of [
      null,
      "broken",
      "{}",
      JSON.stringify(Array(65).fill("basic:text")),
    ])
      expect(parseFavorites(raw)).toEqual(DEFAULT_FAVORITES);
  });
  it("scopes shared definitions to the live project, filters removed and nested symbols, and keeps order", () => {
    const sharedKey = favoriteKey(
      { type: "symbol", symbolId: definition.id },
      projectA,
    );
    const keys = [sharedKey, "basic:rectangle", "builtin:pump"];
    expect(parseFavorites(JSON.stringify(keys))).toEqual(keys);
    const visible = availableFavorites(keys, projectA, [definition], true);
    expect(visible.map((item) => item.key)).toEqual(keys);
    expect(visible[0].definition).toBe(definition);
    expect(
      availableFavorites(keys, projectB, [definition], true).map(
        (item) => item.key,
      ),
    ).toEqual(keys.slice(1));
    expect(
      availableFavorites(keys, projectA, [], true).map((item) => item.key),
    ).toEqual(keys.slice(1));
    expect(
      availableFavorites(keys, projectA, [definition], false).map(
        (item) => item.key,
      ),
    ).toEqual(["basic:rectangle"]);
    expect(definition.name).toBe("ポンプA");
    expect(keys).toEqual([sharedKey, "basic:rectangle", "builtin:pump"]);
  });
});
