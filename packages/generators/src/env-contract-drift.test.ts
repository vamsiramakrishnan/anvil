import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVING_ENV_CONTRACT } from "@anvil/mcp-runtime";
import { RUNTIME_ENV_CONTRACT } from "@anvil/runtime";
import { describe, expect, it } from "vitest";
import { COMPILER_OWNED_RUNTIME_ENV_NAMES, envSchema } from "./deploy.js";

/**
 * Drift guard: every environment variable a serving process reads must be
 * declared in the contract the deploy generator emits as
 * `deploy/env.schema.json`. The scan is over the SOURCE of `@anvil/runtime`
 * and `@anvil/mcp-runtime` — not a curated list — so a new `env.ANVIL_X` read
 * anywhere in either package fails this test until the contract names it.
 * The schema used to be transcribed by hand and had silently lost a dozen
 * variables, including the whole inbound-auth family.
 */

const packagesRoot = fileURLToPath(new URL("../../", import.meta.url));

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourcesUnder(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Every `env.NAME`, `env["NAME"]`, `process.env.NAME` read in the given files. */
function envReads(files: string[]): Map<string, string[]> {
  const reads = new Map<string, string[]>();
  const pattern = /\benv(?:\.|\[")([A-Z][A-Z0-9_]+)(?:"\])?/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const name = match[1] ?? "";
      const sites = reads.get(name) ?? [];
      sites.push(file.slice(packagesRoot.length));
      reads.set(name, sites);
    }
  }
  return reads;
}

describe("deploy/env.schema.json is derived from the runtime's own env contract", () => {
  const schema = envSchema("api.example.com", "prod") as {
    required: string[];
    properties: Record<string, { description?: string; enum?: string[] }>;
    patternProperties: Record<string, unknown>;
  };
  const declared = new Set(Object.keys(schema.properties));
  const credentialPattern = new RegExp(Object.keys(schema.patternProperties)[0] ?? "$^");

  it("declares every variable @anvil/runtime and @anvil/mcp-runtime read", () => {
    const files = [
      ...sourcesUnder(join(packagesRoot, "runtime", "src")),
      ...sourcesUnder(join(packagesRoot, "mcp-runtime", "src")),
    ];
    const reads = envReads(files);
    expect(reads.size).toBeGreaterThan(20);
    const undeclared = [...reads.entries()]
      .filter(([name]) => !declared.has(name) && !credentialPattern.test(name))
      .map(([name, sites]) => `${name} (read at ${[...new Set(sites)].join(", ")})`);
    expect(undeclared, "env reads with no entry in the env contract").toEqual([]);
  });

  it("declares nothing the runtimes do not read", () => {
    const files = [
      ...sourcesUnder(join(packagesRoot, "runtime", "src")),
      ...sourcesUnder(join(packagesRoot, "mcp-runtime", "src")),
    ];
    const reads = envReads(files);
    const unread = [...declared].filter((name) => !reads.has(name));
    expect(unread, "contract entries no runtime code reads").toEqual([]);
  });

  it("names and describes every variable exactly once across both contracts", () => {
    const names = [...RUNTIME_ENV_CONTRACT, ...SERVING_ENV_CONTRACT].map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of [...RUNTIME_ENV_CONTRACT, ...SERVING_ENV_CONTRACT]) {
      expect(v.description.length, v.name).toBeGreaterThan(20);
    }
  });

  it("agrees with the Terraform template about which variables are compiler-owned", () => {
    const owned = RUNTIME_ENV_CONTRACT.filter((v) => v.compilerOwned)
      .map((v) => v.name)
      .sort();
    expect(owned).toEqual([...COMPILER_OWNED_RUNTIME_ENV_NAMES].sort());
  });

  it("keeps the per-bundle facts: environment enum/default and the allowlist example", () => {
    expect(schema.required).toEqual(["ANVIL_SERVICE_ID", "ANVIL_ENV", "ANVIL_ALLOWED_HOSTS"]);
    expect(schema.properties.ANVIL_ENV?.enum).toEqual(["dev", "staging", "prod"]);
    const custom = envSchema(undefined, "uat") as {
      properties: Record<string, { enum?: string[]; default?: string; examples?: string[] }>;
    };
    expect(custom.properties.ANVIL_ENV?.enum).toEqual(["dev", "staging", "prod", "uat"]);
    expect(custom.properties.ANVIL_ENV?.default).toBe("uat");
    expect(custom.properties.ANVIL_ALLOWED_HOSTS?.examples).toEqual(["api.internal.example.com"]);
    expect(schema.properties.ANVIL_ALLOWED_HOSTS).toMatchObject({ examples: ["api.example.com"] });
    // The families the hand-written schema had lost.
    for (const name of [
      "ANVIL_INBOUND_AUTH_MODE",
      "ANVIL_INBOUND_JWKS_URI",
      "ANVIL_PRINCIPALS",
      "ANVIL_RATE_LIMIT_CAPACITY",
      "ANVIL_RECORDS_DIR",
      "ANVIL_EXTENSIONS",
      "PORT",
    ]) {
      expect(declared.has(name), name).toBe(true);
    }
    expect(schema.properties.ANVIL_OTEL_EXPORTER?.enum).toEqual([
      "memory",
      "stdout",
      "otlp",
      "cloud_trace",
    ]);
  });
});
