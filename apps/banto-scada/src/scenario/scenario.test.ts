import { describe, expect, it, vi } from "vitest";
import {
  evaluateScenario,
  frozenTimeSec,
  parseScenario,
  ScenarioError,
  type ScenarioValue,
} from "./scenario";

// 筋書きの共通の試験ケース（Rust の `crates/scada-scenario/tests/cases.rs` も同じものを通す）。
// `SCENARIO_BLESS=1` で走らせると、`scenarioFile` を使うケースの期待値をこの評価部で書き直す。

// Node-only IO; keep the application's browser-only type environment.
interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
  writeFileSync(path: URL, text: string): void;
  readdirSync(path: URL): string[];
}
interface NodeProcess {
  env: Record<string, string | undefined>;
}
const fs = () => vi.importActual<NodeFs>("node:fs");
const TESTS = new URL(
  "../../../../crates/scada-scenario/tests/",
  import.meta.url,
);
const CASES = new URL("cases/", TESTS);
const TOLERANCE = 1e-9;

interface Case {
  name: string;
  scenario?: unknown;
  scenarioFile?: string;
  frozenTimeSec: number | null;
  samples: { tSec: number; values: Record<string, ScenarioValue> }[];
}

async function loadCases() {
  const { readFileSync, readdirSync } = await fs();
  return readdirSync(CASES)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((file) => {
      const url = new URL(file, CASES);
      const data = JSON.parse(readFileSync(url, "utf8")) as Case;
      const scenario =
        data.scenarioFile === undefined
          ? data.scenario
          : JSON.parse(readFileSync(new URL(data.scenarioFile, url), "utf8"));
      return { file, url, data, scenario };
    });
}

describe("shared scenario cases", () => {
  it("gives the expected values at every sample", async () => {
    const bless =
      (globalThis as unknown as { process: NodeProcess }).process.env
        .SCENARIO_BLESS === "1";
    const cases = await loadCases();
    expect(cases.length).toBeGreaterThan(1);
    for (const { file, url, data, scenario: json } of cases) {
      const scenario = parseScenario(json);
      if (bless && data.scenarioFile !== undefined) {
        for (const sample of data.samples)
          sample.values = evaluateScenario(scenario, sample.tSec);
        const { writeFileSync } = await fs();
        writeFileSync(url, JSON.stringify(data, null, 2) + "\n");
      }
      expect(frozenTimeSec(scenario), file).toBe(data.frozenTimeSec);
      for (const sample of data.samples) {
        const actual = evaluateScenario(scenario, sample.tSec);
        const where = `${file} t=${sample.tSec}`;
        expect(Object.keys(actual).sort(), where).toEqual(
          Object.keys(sample.values).sort(),
        );
        for (const [name, expected] of Object.entries(sample.values)) {
          const value = actual[name];
          if (typeof expected === "boolean")
            expect(value, `${where} ${name}`).toBe(expected);
          else {
            expect(typeof value, `${where} ${name}`).toBe("number");
            expect(
              Math.abs((value as number) - expected),
              `${where} ${name}: ${value} != ${expected}`,
            ).toBeLessThanOrEqual(TOLERANCE);
          }
        }
      }
    }
  });

  it("refuses every invalid scenario", async () => {
    const { readFileSync } = await fs();
    const invalid = JSON.parse(
      readFileSync(new URL("invalid.json", TESTS), "utf8"),
    ) as { name: string; scenario: unknown }[];
    expect(invalid.length).toBeGreaterThan(10);
    for (const { name, scenario } of invalid)
      expect(() => parseScenario(scenario), name).toThrow(ScenarioError);
  });
});

describe("scenario details", () => {
  const scenario = parseScenario({
    format: "banto-scenario",
    version: 1,
    cycleSec: 10,
    signals: { A: { kind: "number", base: 1 } },
    events: [
      { atSec: 2, durationSec: 4, values: { A: 2 } },
      { atSec: 4, durationSec: 4, values: { A: 3 } },
    ],
  });

  it("lets the later event win where events overlap", () => {
    expect(evaluateScenario(scenario, 3).A).toBe(2);
    expect(evaluateScenario(scenario, 5).A).toBe(3);
    expect(evaluateScenario(scenario, 7).A).toBe(3);
    expect(evaluateScenario(scenario, 9).A).toBe(1);
  });

  it("freezes at the given second, else the scenario's, else not at all", () => {
    expect(frozenTimeSec(scenario)).toBeNull();
    expect(frozenTimeSec(scenario, 7)).toBe(7);
  });
});
