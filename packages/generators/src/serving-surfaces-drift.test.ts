import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import { generateBundle } from "./index.js";

/**
 * Every serving surface builds its execute context from `bootRuntime`'s
 * `contextDeps` and resolves the caller with `boot.principalFor(...)`. This
 * is the guard that keeps the class of bug where a dependency the root
 * resolves (policy hooks, the exporter, the rate and spend limiters, the
 * principal directory) is consumed by one surface and silently dropped by
 * the other four. It reads the two hand-written surfaces and the two
 * generated entrypoints as text, so a refactor that stops spreading
 * `contextDeps` or drops `principal` fails here, not in production.
 */

const packagesRoot = fileURLToPath(new URL("../../", import.meta.url));

const handWritten = {
  "mcp-runtime/src/serve.ts (deployed runtime/server.js)": join(
    packagesRoot,
    "mcp-runtime/src/serve.ts",
  ),
  "cli/src/commands/serve.ts (anvil serve mcp --fleet)": join(
    packagesRoot,
    "cli/src/commands/serve.ts",
  ),
  "cli/src/tool-cli.ts (generated CLI direct path)": join(packagesRoot, "cli/src/tool-cli.ts"),
};

describe("serving surfaces boot through one root", () => {
  it("every hand-written surface spreads contextDeps and resolves the caller with principalFor", () => {
    for (const [name, path] of Object.entries(handWritten)) {
      const src = readFileSync(path, "utf8");
      expect(src, `${name} must spread boot.contextDeps`).toMatch(
        /\.\.\.(boot\.contextDeps|deps)\b/,
      );
      expect(src, `${name} must resolve the caller via boot.principalFor`).toContain(
        "boot.principalFor(",
      );
      // The limiters and the directory flag ride contextDeps; a surface that
      // builds them by hand is the drift this test exists to catch.
      expect(src, `${name} must not build the limits gate itself`).not.toContain(
        "buildLimitsGate(",
      );
      expect(src, `${name} must not resolve the session principal itself`).not.toContain(
        "resolvePrincipalForEnv(",
      );
    }
  });

  it("both generated MCP entrypoints do the same", async () => {
    const read = (rel: string) => readFileSync(join(packagesRoot, "..", "examples", rel), "utf8");
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: read("payments/anvil.yaml"),
      serviceId: "payments",
    });
    const bundle = generateBundle(air);
    for (const file of ["mcp/server.js", "mcp/server-sse.js"]) {
      const src = bundle.files[file];
      expect(src, file).toBeDefined();
      expect(src, file).toContain("...boot.contextDeps");
      expect(src, file).toContain("principal: boot.principalFor(");
    }
  });

  it("the root's contextDeps carries the limiters and the directory flag", () => {
    const boot = readFileSync(join(packagesRoot, "runtime/src/boot.ts"), "utf8");
    const block = boot.slice(
      boot.indexOf("contextDeps: {"),
      boot.indexOf("};", boot.indexOf("contextDeps: {")),
    );
    expect(block).toContain("limits: LimitsGate;");
    expect(block).toContain("principalDirectoryConfigured: boolean;");
  });
});
