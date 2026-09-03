import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Architectural ratchets.
 *
 * `architecture.test.ts` next door asserts a handful of named boundaries. This
 * file asserts the *shape* of the workspace: which packages may depend on which,
 * that nothing reaches past a package's public entry point, that the serving path
 * stays free of build-time code, and that the modules which concentrate change do
 * not grow.
 *
 * These are ratchets, not aspirations. Every one of them passes at the commit
 * that introduced it — they exist to keep true things true, and each failure
 * message says what to do rather than only what broke.
 *
 * Deliberately dependency-free: this file imports nothing from `@anvil/*` so it
 * cannot itself perturb the graph it measures.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);

/* -------------------------------------------------------------------------- */
/* Workspace facts                                                             */
/* -------------------------------------------------------------------------- */

const PACKAGES = readdirSync(join(root, "packages")).filter((name) =>
  statSync(join(root, "packages", name)).isDirectory(),
);

function manifest(pkg: string): { name?: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, "packages", pkg, "package.json"), "utf8"));
}

/** Directory name → published package name, e.g. `air` → `@anvil/air`. */
const PACKAGE_NAME = new Map(PACKAGES.map((dir) => [dir, manifest(dir).name ?? `@anvil/${dir}`]));
const DIR_FOR_NAME = new Map([...PACKAGE_NAME].map(([dir, name]) => [name, dir]));

function sourceFiles(dir: string, includeTests = false): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && (includeTests || !entry.name.endsWith(".test.ts")))
        out.push(full);
    }
  };
  walk(dir);
  return out;
}

function packageSources(pkg: string, includeTests = false): string[] {
  return sourceFiles(join(root, "packages", pkg, "src"), includeTests);
}

interface ImportRecord {
  /** The module specifier, e.g. `@anvil/air` or `./sibling.js`. */
  from: string;
  /** Named value bindings; empty for `import type` and namespace/default imports. */
  valueNames: string[];
}

/**
 * Read a file's *real* imports.
 *
 * Regex does not work here. `@anvil/generators` emits the generated per-service
 * CLI as a template literal that itself contains `import { runToolCli } from
 * "@anvil/cli"` — text that looks exactly like a dependency edge and is not one.
 * A first draft of this file reported that as an undeclared cycle. Parsing means
 * the ratchet measures the module graph rather than the character stream.
 */
function importsOf(file: string): ImportRecord[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const records: ImportRecord[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const valueNames: string[] = [];
    if (clause && !clause.isTypeOnly && clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (!element.isTypeOnly) valueNames.push((element.propertyName ?? element.name).text);
        }
      }
    }
    records.push({ from: statement.moduleSpecifier.text, valueNames });
  }
  return records;
}

/** Declared `@anvil/*` dependencies, by directory name. */
function declaredDeps(pkg: string): Set<string> {
  const deps = Object.keys(manifest(pkg).dependencies ?? {}).filter((d) => d.startsWith("@anvil/"));
  return new Set(deps.map((d) => DIR_FOR_NAME.get(d) ?? d.replace("@anvil/", "")));
}

/** `@anvil/*` packages actually imported by a package's non-test source. */
function importedDeps(pkg: string): Set<string> {
  const found = new Set<string>();
  for (const file of packageSources(pkg)) {
    for (const { from } of importsOf(file)) {
      const dir = DIR_FOR_NAME.get(from.split("/").slice(0, 2).join("/"));
      if (dir && dir !== pkg) found.add(dir);
    }
  }
  return found;
}

const GRAPH = new Map(PACKAGES.map((pkg) => [pkg, declaredDeps(pkg)]));

/* -------------------------------------------------------------------------- */
/* Dependency direction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The allowed edges, recorded from the graph as it stands. This is an allow-list
 * rather than a layer diagram on purpose: the repository's real layering is finer
 * than the tiers anyone has drawn for it (`system-pack` sits next to `air`, not up
 * with the generators; `certification` and `generators` are siblings, not stacked),
 * and encoding the tiers would have forced the code to match a worse picture.
 *
 * Adding an edge here is allowed. It just has to be a line in a diff.
 */
const ALLOWED_EDGES: Record<string, readonly string[]> = {
  air: [],
  grammar: [],
  // Design tokens: two dependency-free .mjs modules and the CSS generated from
  // them. Imports nothing — a colour source that could reach any other package
  // would be a colour source that can drift with it.
  design: [],
  "system-pack": ["air"],
  compiler: ["air", "grammar"],
  refinement: ["air", "grammar"],
  runtime: ["air", "grammar"],
  "mcp-runtime": ["air", "runtime"],
  simulator: ["air", "compiler"],
  targets: ["air", "compiler"],
  // "runtime" added for async-events Phase 4: certification's new webhook
  // checks reuse hostIsAllowed rather than reimplementing egress-allowlist
  // logic. No cycle: runtime depends on nothing above it in this list.
  certification: ["air", "compiler", "runtime", "simulator", "system-pack"],
  generators: ["air", "compiler", "mcp-runtime", "refinement", "runtime"],
  harness: ["air", "compiler", "generators", "mcp-runtime", "refinement", "runtime"],
  // The deployment-local legacy bridge: a standalone HTTP facade process, not
  // part of the deployed MCP server's own dependency closure (mcp-runtime
  // never depends on it — see "serving-path isolation" below). It needs the
  // reviewed binding/plan/report shapes from compiler's legacy subsystem and
  // the QueueRequestReplyWireBinding schema from air; nothing else.
  "legacy-bridge": ["air", "compiler"],
  // The review console is a pure projection: it reads bundles, packs, and
  // reports from disk and writes only through the library functions the CLI
  // itself calls. It sits beside the CLI, below it in the graph (cli -> console
  // is the launch edge; console never imports cli), and may reach the same
  // library packages the CLI reaches for reading and deciding — never the
  // serving path, never targets. Listed edges are the allowed set; the package
  // declares only those it imports today. `design` is the UI's token source
  // (tokens.css) — the console consumes colours from it and nowhere else.
  console: ["air", "compiler", "design", "generators", "harness", "refinement", "system-pack"],
  cli: [
    "air",
    "certification",
    "compiler",
    "generators",
    "harness",
    "refinement",
    "runtime",
    // The distribution seam: `anvil pack` assembles, verifies, and installs
    // content-addressed packs. Same direction certification already points.
    "system-pack",
    "targets",
    // `anvil legacy bridge conformance` boots the facade and runs it against
    // an in-process broker double.
    "legacy-bridge",
    // `anvil console` launches the review console; the console never imports
    // the CLI, so this edge cannot close a cycle.
    "console",
    // `anvil serve mcp --fleet` composes the fleet MCP server
    // (buildFleetServer). Same direction generators already points (cli ->
    // generators -> mcp-runtime); no cycle.
    "mcp-runtime",
  ],
};

describe("package dependency direction", () => {
  it("every workspace package is covered by the allow-list", () => {
    expect([...PACKAGES].sort()).toEqual(Object.keys(ALLOWED_EDGES).sort());
  });

  it("declares no dependency outside the allow-list", () => {
    for (const pkg of PACKAGES) {
      const allowed = new Set(ALLOWED_EDGES[pkg] ?? []);
      const extra = [...(GRAPH.get(pkg) ?? [])].filter((dep) => !allowed.has(dep)).sort();
      expect(
        extra,
        `${pkg} depends on ${extra.join(", ")}, which ALLOWED_EDGES does not permit. ` +
          `If the edge is intended, add it here and say why in the commit.`,
      ).toEqual([]);
    }
  });

  it("has no cycles", () => {
    const state = new Map<string, "visiting" | "done">();
    const walk = (pkg: string, stack: string[]): void => {
      if (state.get(pkg) === "done") return;
      if (state.get(pkg) === "visiting") {
        throw new Error(`Dependency cycle: ${[...stack, pkg].join(" -> ")}`);
      }
      state.set(pkg, "visiting");
      for (const dep of GRAPH.get(pkg) ?? []) walk(dep, [...stack, pkg]);
      state.set(pkg, "done");
    };
    expect(() => {
      for (const pkg of PACKAGES) walk(pkg, []);
    }).not.toThrow();
  });

  it("imports exactly what it declares — no phantom or stale dependencies", () => {
    for (const pkg of PACKAGES) {
      const declared = GRAPH.get(pkg) ?? new Set();
      const imported = importedDeps(pkg);
      const phantom = [...imported].filter((d) => !declared.has(d)).sort();
      expect(
        phantom,
        `${pkg} imports ${phantom.join(", ")} without declaring it. It resolves today only ` +
          `through hoisting or the vitest alias, and would break a real install.`,
      ).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Public API boundaries                                                       */
/* -------------------------------------------------------------------------- */

describe("package public API boundaries", () => {
  it("imports only package entry points or explicitly exported subpaths", () => {
    const offenders: string[] = [];
    for (const pkg of PACKAGES) {
      for (const file of packageSources(pkg, true)) {
        for (const { from } of importsOf(file)) {
          if (!from.startsWith("@anvil/")) continue;
          const [, packageName, ...subpath] = from.split("/");
          if (subpath.length === 0) continue;
          const manifestPath = join(root, "packages", packageName ?? "", "package.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            exports?: Record<string, unknown>;
          };
          if (!manifest.exports?.[`./${subpath.join("/")}`]) {
            offenders.push(`${file.slice(root.length)}: ${from}`);
          }
        }
      }
    }
    expect(
      offenders,
      "Unexported deep imports bypass a package's public surface. Declare an intentional subpath in package.json or import the package entry point.",
    ).toEqual([]);
  });

  it("no source file reaches into another package by relative path", () => {
    const offenders: string[] = [];
    const packagesRoot = join(root, "packages");
    for (const pkg of PACKAGES) {
      const pkgSrc = join(root, "packages", pkg, "src");
      for (const file of packageSources(pkg, true)) {
        for (const { from } of importsOf(file)) {
          if (!from.startsWith(".")) continue;
          const target = join(file, "..", from);
          // Reaching outside packages/ is fine — tests legitimately read fixtures
          // from examples/ and tools/. Reaching into another package's src is not.
          if (target.startsWith(packagesRoot) && !target.startsWith(pkgSrc)) {
            offenders.push(`${file.slice(root.length)}: ${from}`);
          }
        }
      }
    }
    expect(
      offenders,
      "Import through the package's public entry point instead of its file layout.",
    ).toEqual([]);
  });

  it("every package resolves its own declared entry point", () => {
    for (const pkg of PACKAGES) {
      expect(() => statSync(join(root, "packages", pkg, "src", "index.ts"))).not.toThrow(
        `${pkg} has no src/index.ts`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Serving-path isolation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The deployed unit is the MCP server, which depends on `@anvil/mcp-runtime`. Its
 * transitive closure must contain nothing that exists to *build* artifacts — no
 * spec parsing, no generation, no enrichment, no certification — because the
 * build/run split is what keeps a deployed server small and unable to recompile
 * itself. `architecture.test.ts` asserts this for direct imports; this asserts it
 * transitively, which is the form that actually holds the line.
 */
const BUILD_TIME_PACKAGES = [
  "console",
  "compiler",
  "generators",
  "harness",
  "refinement",
  "certification",
  "simulator",
  "targets",
  "system-pack",
  "cli",
];

describe("serving-path isolation", () => {
  it("the transitive closure of the serving path contains no build-time package", () => {
    const closure = new Set<string>();
    const walk = (pkg: string): void => {
      for (const dep of GRAPH.get(pkg) ?? []) {
        if (closure.has(dep)) continue;
        closure.add(dep);
        walk(dep);
      }
    };
    for (const entry of ["runtime", "mcp-runtime"]) walk(entry);

    const leaked = BUILD_TIME_PACKAGES.filter((p) => closure.has(p));
    expect(
      leaked,
      `The serving path transitively reaches ${leaked.join(", ")}. The deployed MCP server ` +
        `must not be able to parse a spec or generate an artifact.`,
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Phantom platform APIs                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Test files are excluded from `tsc` in every package, so a test can import a
 * name that does not exist and stay green forever — which is exactly how
 * `fs.mkfifoSync` (no such export) survived in a bug-bash test whose assertion
 * had therefore never run. Typechecking the ~70k lines of test source is the real
 * fix and is a much larger change (366 errors today, recorded in the audit); this
 * closes the specific hole cheaply in the meantime.
 *
 * Value imports only — `import type` names are erased and legitimately absent at
 * runtime.
 */
describe("no phantom Node built-in imports", () => {
  it("every named value import from a node: module actually exists", () => {
    const missing: string[] = [];
    for (const pkg of PACKAGES) {
      for (const file of packageSources(pkg, true)) {
        for (const { from, valueNames } of importsOf(file)) {
          if (!from.startsWith("node:") || valueNames.length === 0) continue;
          const mod = require(from) as Record<string, unknown>;
          for (const name of valueNames) {
            if (!(name in mod)) missing.push(`${file.slice(root.length)}: ${from}.${name}`);
          }
        }
      }
    }
    expect(
      missing,
      "These names do not exist on the module they are imported from; any call throws TypeError.",
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Module-size ratchet                                                         */
/* -------------------------------------------------------------------------- */

interface SizeBaseline {
  threshold: number;
  slack: number;
  modules: Record<string, { lines: number; plan: string }>;
}

const BASELINE_PATH = "docs/architecture/module-size-baseline.json";

describe("module-size ratchet", () => {
  const baseline: SizeBaseline = JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8"));

  const measured = new Map<string, number>();
  for (const pkg of PACKAGES) {
    for (const file of packageSources(pkg)) {
      const rel = file.slice(root.length);
      measured.set(rel, readFileSync(file, "utf8").split("\n").length - 1);
    }
  }

  it("no recorded module has grown", () => {
    const grown = Object.entries(baseline.modules)
      .map(([path, entry]) => ({ path, was: entry.lines, now: measured.get(path) }))
      .filter((m) => m.now !== undefined && m.now > m.was)
      .map((m) => `${m.path}: ${m.was} -> ${m.now}`);
    expect(
      grown,
      `These modules are already change-concentration hotspots. Put new behaviour in a module ` +
        `that owns it, or decompose first and lower the baseline.`,
    ).toEqual([]);
  });

  it("banks improvements instead of leaving them as headroom", () => {
    const shrunk = Object.entries(baseline.modules)
      .map(([path, entry]) => ({ path, was: entry.lines, now: measured.get(path) }))
      .filter((m) => m.now !== undefined && m.now < m.was - baseline.slack)
      .map((m) => `${m.path}: recorded ${m.was}, now ${m.now}`);
    expect(
      shrunk,
      `Lower these numbers in ${BASELINE_PATH} in the same change, or the ratchet keeps ` +
        `allowing the regression you just removed.`,
    ).toEqual([]);
  });

  it("records every module over the threshold, with a plan", () => {
    const unrecorded = [...measured]
      .filter(([path, lines]) => lines >= baseline.threshold && !baseline.modules[path])
      .map(([path, lines]) => `${path} (${lines})`)
      .sort();
    expect(
      unrecorded,
      `A module crossed ${baseline.threshold} lines without being declared. Add it to ` +
        `${BASELINE_PATH} with a plan, or keep it under the threshold.`,
    ).toEqual([]);

    const planless = Object.entries(baseline.modules)
      .filter(([, entry]) => !entry.plan || entry.plan === "TODO")
      .map(([path]) => path);
    expect(
      planless,
      "Every recorded exception needs an owner's plan, not a grandfather clause.",
    ).toEqual([]);
  });

  it("does not record modules that no longer exist", () => {
    const stale = Object.keys(baseline.modules).filter((path) => !measured.has(path));
    expect(stale, `Remove these from ${BASELINE_PATH}; they have been deleted or renamed.`).toEqual(
      [],
    );
  });
});
