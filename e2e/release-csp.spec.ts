import { test, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve } from "node:path";
import tauri from "../apps/banto-scada/src-tauri/tauri.conf.json" with { type: "json" };

// The Tauri release build serves dist/ under app.security.csp (no 'unsafe-eval').
// Build the bundle, serve it with the same header, and require both windows to
// mount without an EvalError (e.g. Ajv compiling a schema with `new Function`).
const APP = resolve(import.meta.dirname, "../apps/banto-scada");
const CSP = tauri.app.security.csp;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
const EVAL = /EvalError|unsafe-eval|Content Security Policy/i;

let server: Server | undefined;
let origin: string;

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  const dist = testInfo.outputPath("dist");
  execSync(`pnpm exec vite build --outDir "${dist}" --emptyOutDir`, {
    cwd: APP,
    stdio: "pipe",
    timeout: 150_000,
  });
  const listening = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = normalize(join(dist, path === "/" ? "index.html" : path));
    if (!file.startsWith(dist)) return response.writeHead(403).end();
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Content-Security-Policy": CSP,
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "Content-Security-Policy": CSP }).end();
    }
  });
  await new Promise<void>((done) => listening.listen(0, "127.0.0.1", done));
  server = listening;
  origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  // build に失敗したときは server が無い。done を待たずに抜け、本来のエラーを残す。
  const running = server;
  if (!running) return;
  await new Promise((done) => running.close(done));
});

function collectErrors(page: Page) {
  const pageErrors: string[] = [];
  const evalMessages: string[] = [];
  page.on("pageerror", (error) =>
    pageErrors.push(`${error.name}: ${error.message}`),
  );
  page.on("console", (message) => {
    if (EVAL.test(message.text())) evalMessages.push(message.text());
  });
  return { pageErrors, evalMessages };
}

test("CSP の下で Editor が組み立てられる", async ({ page }) => {
  const { pageErrors, evalMessages } = collectErrors(page);
  const response = await page.goto(`${origin}/index.html`);
  expect(response?.headers()["content-security-policy"]).toBe(CSP);
  await expect(page.locator("#app")).not.toBeEmpty();
  await expect(page.getByRole("menubar").first()).toBeVisible();
  expect(evalMessages).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("CSP の下で Runtime が描画され、EvalError を出さない", async ({
  page,
}) => {
  // A host that answers nothing: enough for runtime.ts to load RuntimeShell
  // (and its validators). The Runtime may then show its own failure screen.
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        transformCallback: () => 0,
        invoke: async (command: string) => {
          throw Error(`no native host: ${command}`);
        },
      },
    });
  });
  const { pageErrors, evalMessages } = collectErrors(page);
  await page.goto(`${origin}/runtime.html`);
  await expect(page.locator("#app")).not.toBeEmpty();
  await expect(page.getByText("デスクトップ版でだけ使えます")).toHaveCount(0);
  expect(evalMessages).toEqual([]);
  expect(pageErrors.filter((error) => EVAL.test(error))).toEqual([]);
});
