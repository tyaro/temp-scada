import { expect, it, vi } from "vitest";

// Node-only IO; keep the application's browser-only type environment.
interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { recursive: true }): string[];
}
interface Generator {
  OUTPUT_DIR: URL;
  generateValidators(): Record<string, string>;
}
const fs = () => vi.importActual<NodeFs>("node:fs");
const lf = (text: string) => text.replace(/\r\n/g, "\n");

it("keeps the committed validators in sync with the schemas", async () => {
  const { readFileSync, readdirSync } = await fs();
  const { OUTPUT_DIR, generateValidators } = await vi.importActual<Generator>(
    "../../scripts/generate-validators.mjs",
  );
  const expected = generateValidators();
  const hint = "stale validators: run `pnpm generate:validators`";
  expect(readdirSync(OUTPUT_DIR, { recursive: true }).sort(), hint).toEqual(
    Object.keys(expected).sort(),
  );
  for (const [name, content] of Object.entries(expected)) {
    const committed = lf(readFileSync(new URL(name, OUTPUT_DIR), "utf8"));
    expect(committed === content, `${hint} (${name} differs)`).toBe(true);
  }
});

it("does not compile JSON Schema at runtime in product code", async () => {
  // The release CSP has no 'unsafe-eval'; Ajv's compile uses `new Function`.
  const { readFileSync, readdirSync } = await fs();
  const src = new URL("../", import.meta.url);
  const offenders = readdirSync(src, { recursive: true })
    .map((path) => path.replace(/\\/g, "/"))
    .filter((path) => /\.(ts|js|svelte)$/.test(path))
    .filter((path) => !path.endsWith(".test.ts"))
    .filter((path) => {
      const text = readFileSync(new URL(path, src), "utf8");
      return (
        /\bnew\s+Ajv\w*\b/.test(text) ||
        /^import\s+(?!type\b)[^;]*from\s+"ajv(\/dist\/(?!runtime\/)[^"]*)?"/m.test(
          text,
        )
      );
    });
  expect(
    offenders,
    "import the pre-generated validator from src/lib/generated/validators/",
  ).toEqual([]);
});
