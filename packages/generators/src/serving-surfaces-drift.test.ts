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

/**
 * Every object literal in `src` that spreads the root's `contextDeps`: one per
 * execute context the surface builds. Returned as source text so an assertion
 * can ask what each context sets, rather than what the file mentions anywhere.
 */
interface ExecuteContext {
  literal: string;
  /** Passed to `createBusinessServing`, which supplies the caller per request. */
  delegated: boolean;
}

function executeContexts(src: string): ExecuteContext[] {
  const out: ExecuteContext[] = [];
  const spread = /\.\.\.(?:boot\.contextDeps|deps)\b/g;
  for (let hit = spread.exec(src); hit; hit = spread.exec(src)) {
    let open = hit.index;
    while (open > 0 && src[open] !== "{") open -= 1;
    let depth = 0;
    let close = open;
    for (; close < src.length; close += 1) {
      if (src[close] === "{") depth += 1;
      else if (src[close] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push({
      literal: src.slice(open, close + 1),
      delegated: src.slice(Math.max(0, open - 200), open).includes("createBusinessServing("),
    });
  }
  return out;
}

const handWritten = {
  "mcp-runtime/src/serve.ts (deployed runtime/server.js)": join(
    packagesRoot,
    "mcp-runtime/src/serve.ts",
  ),
  "cli/src/commands/serve.ts (anvil serve mcp, single bundle and --fleet)": join(
    packagesRoot,
    "cli/src/commands/serve.ts",
  ),
  "cli/src/tool-cli.ts (generated CLI direct path)": join(packagesRoot, "cli/src/tool-cli.ts"),
};

describe("serving surfaces boot through one root", () => {
  it("every execute context that spreads contextDeps also resolves its caller", () => {
    // Per CONTEXT, not per file. A file-wide search passes as soon as ONE
    // context in a file resolves a caller, which is how a second context in
    // the same file (single-bundle stdio, beside the fleet) shipped spreading
    // `principalDirectoryConfigured` with no `principal` — the combination
    // `execute()` refuses fail-closed on every call.
    for (const [name, path] of Object.entries(handWritten)) {
      const src = readFileSync(path, "utf8");
      const contexts = executeContexts(src);
      expect(contexts.length, `${name} builds no execute context`).toBeGreaterThan(0);
      for (const [index, { literal, delegated }] of contexts.entries()) {
        // A base context handed to `createBusinessServing` is the one
        // exception: that layer derives the caller from the verified inbound
        // identity and overrides `principal` on every request. The exemption
        // is only sound while it keeps doing so, which the next case asserts.
        if (delegated) continue;
        // Otherwise: either the context resolves the caller itself, or it
        // takes one a caller-owning transport already resolved (the fleet
        // builder does the latter — one HTTP session is one caller).
        expect(literal, `${name} context #${index + 1} must set principal`).toMatch(
          // `principal: boot.principalFor(...)`, or the shorthand `principal,`
          // where a caller-owning transport passed one in.
          /principal: boot\.principalFor\(|^\s*principal,\s*$/m,
        );
      }
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

  it("the business layer supplies the caller the base context it is handed does not", () => {
    // What makes the exemption above sound: `createBusinessServing` builds its
    // per-request context from the verified inbound identity and sets
    // `principal` there, so the base context's missing one is never what
    // `execute()` sees.
    const src = readFileSync(join(packagesRoot, "mcp-runtime/src/business-serving.ts"), "utf8");
    expect(src).toMatch(/principal: \{ id: context\.principal/);
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
