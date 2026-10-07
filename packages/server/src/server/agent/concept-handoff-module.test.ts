// SOURCE_ONLY module/layout checks; no application build, daemon or provider call.
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { conceptFinalHandoffModuleUrl } from "./concept-handoff-module.js";

test("source and configured tsc emitted layouts resolve the same private fork module", async () => {
  const source = new URL("./concept-handoff.ts", import.meta.url);
  const server = fileURLToPath(new URL("../../../", source));
  const { compilerOptions } = JSON.parse(
    readFileSync(resolve(server, "tsconfig.server.json"), "utf8"),
  );
  const emitted = pathToFileURL(
    resolve(
      server,
      compilerOptions.outDir,
      relative(resolve(server, compilerOptions.rootDir), fileURLToPath(source)).replace(
        /\.ts$/,
        ".js",
      ),
    ),
  );
  expect(emitted.pathname).toMatch(
    /\/packages\/server\/dist\/server\/server\/agent\/concept-handoff.js$/,
  );
  const expected = new URL("../../../../../study/employee-concept-final-handoff.mjs", source);
  expect(conceptFinalHandoffModuleUrl(source).href).toBe(expected.href);
  expect(conceptFinalHandoffModuleUrl(emitted).href).toBe(expected.href);
  // The old five-parent expression points to packages/study after compilation.
  expect(new URL("../../../../../study/employee-concept-final-handoff.mjs", emitted).href).not.toBe(
    expected.href,
  );
  const module = await import(conceptFinalHandoffModuleUrl(emitted).href);
  expect(typeof module.selectedFinalForHandoff).toBe("function");
  expect(readFileSync(source, "utf8")).toContain(
    "conceptFinalHandoffModuleUrl(new URL(import.meta.url)).href",
  );
});

test("unknown layouts and non-file inputs deny instead of searching or falling back", () => {
  for (const url of [
    "file:///fixture/server/agent/concept-handoff.js",
    "file:///fixture/packages/server/dist/server/agent/concept-handoff.js",
    "file:///fixture/packages/server/src/server/agent/concept-handoff.ts?alternate=1",
    "https://fixture/packages/server/src/server/agent/concept-handoff.ts",
  ])
    expect(() => conceptFinalHandoffModuleUrl(new URL(url))).toThrow(
      "Unknown concept handoff module layout",
    );
  const source = new URL(
    "file:///synthetic%20source/packages/server/src/server/agent/concept-handoff.ts",
  );
  const emitted = new URL(
    "file:///synthetic%20source/packages/server/dist/server/server/agent/concept-handoff.js",
  );
  expect(conceptFinalHandoffModuleUrl(source).href).toBe(
    conceptFinalHandoffModuleUrl(emitted).href,
  );
});
