import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Anvil's machine-readable error codes are a public contract.
 *
 * An operator writing `if (r.code === "gateway_receipt/output_lineage_stale")`
 * is depending on that exact string. Rename or drop it and their branch stops
 * matching — silently, on an upgrade, with the `else` path (usually "proceed")
 * taking over. That is worse than a crash, because nothing reports it.
 *
 * 305 codes reach operators today. Before this file, 76 of them had no assertion
 * anywhere in the workspace, so a refactor could have changed any of those
 * without a single test going red.
 *
 * This is a ratchet in the same shape as the module-size one: it records where
 * things stand, prevents them getting worse, and requires improvements to be
 * banked so they are not left as headroom.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const REGISTRY_PATH = "docs/architecture/error-code-registry.json";

interface Registry {
  total: number;
  asserted: number;
  unasserted: number;
  codes: Record<string, { packages: string[]; asserted: boolean }>;
}

const registry: Registry = JSON.parse(readFileSync(join(root, REGISTRY_PATH), "utf8"));

/* -------------------------------------------------------------------------- */
/* Extraction                                                                  */
/* -------------------------------------------------------------------------- */

const CODE_SHAPE = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_.]*$/;

/**
 * Namespaces whose strings share the shape of a code without being one.
 * `static/*` and `exec/*` are certification check ids and `anvil/*` are AIR
 * predicate names — both real contracts, but not this one.
 */
const NOT_ERROR_CODES = new Set([
  "application",
  "text",
  "image",
  "audio",
  "video",
  "anvil",
  "pure",
]);

/**
 * Collect the codes a file emits.
 *
 * Position, not shape. A plain shape match sweeps in `reference/workflow.md`
 * and `application/json`; a first draft of the registry did exactly that and
 * reported 435 codes, a third of them file paths. A string counts only where it
 * is *used* as a code.
 */
function codesIn(file: string): Set<string> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found = new Set<string>();
  const take = (node: ts.Node | undefined): void => {
    if (!node || !ts.isStringLiteral(node)) return;
    if (CODE_SHAPE.test(node.text) && !NOT_ERROR_CODES.has(node.text.split("/")[0] as string)) {
      found.add(node.text);
    }
  };
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === "code") take(node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText().endsWith("code")
    ) {
      take(node.right);
    }
    if (ts.isNewExpression(node) && /Error$/.test(node.expression.getText())) {
      take(node.arguments?.[0]);
    }
    if (
      ts.isCallExpression(node) &&
      /^(emit|refuse|reject)/.test(node.expression.getText().split(".").pop() ?? "")
    ) {
      for (const argument of node.arguments ?? []) take(argument);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

/**
 * Only `packages/*​/src`. Walking `packages/` wholesale also sweeps in `dist/`,
 * whose `.d.ts` files pass a naive `.ts` filter — that mis-attributes every code
 * to whichever package last built, and made this file take three minutes.
 */
function walkFiles(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (keep(entry)) out.push(full);
    }
  };
  visit(dir);
  return out;
}

const packagesDir = join(root, "packages");
const sourceRoots = readdirSync(packagesDir)
  .map((pkg) => join(packagesDir, pkg, "src"))
  .filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });

const productionFiles = sourceRoots.flatMap((dir) =>
  walkFiles(dir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
);
const testFiles = sourceRoots.flatMap((dir) => walkFiles(dir, (name) => name.endsWith(".test.ts")));

const emitted = new Map<string, Set<string>>();
for (const file of productionFiles) {
  const pkg = file.slice(packagesDir.length + 1).split("/")[0] as string;
  for (const code of codesIn(file)) {
    if (!emitted.has(code)) emitted.set(code, new Set());
    (emitted.get(code) as Set<string>).add(pkg);
  }
}

/**
 * This file is excluded from its own corpus. It is *about* codes rather than
 * asserting them, so a code quoted in a comment here would otherwise read as
 * covered — which is exactly the kind of self-flattering measurement this
 * programme keeps finding. (It caught itself: the doc comment above quotes
 * `gateway_receipt/output_lineage_stale`, one of the unasserted ones.)
 *
 * The heuristic's limit is deliberate and worth stating: `asserted` means some
 * test names the exact string. That is a weaker claim than "the behaviour behind
 * it is covered", and it is the right claim, because the contract being ratcheted
 * here is the string an operator matches on.
 */
const SELF = "error-code-registry.test.ts";
const testCorpus = testFiles
  .filter((file) => !file.endsWith(SELF))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const isAsserted = (code: string): boolean => testCorpus.includes(`"${code}"`);

const REGENERATE =
  "regenerate the registry (see its $comment) and commit the result in the same change";

/* -------------------------------------------------------------------------- */
/* The ratchet                                                                 */
/* -------------------------------------------------------------------------- */

describe("error-code registry", () => {
  it("registers every code the workspace emits", () => {
    const unregistered = [...emitted.keys()].filter((code) => !registry.codes[code]).sort();
    expect(
      unregistered,
      `These codes reach an operator but are not in ${REGISTRY_PATH}. A new code is a new ` +
        `public string someone will branch on, so it should be a reviewed line in a diff — ${REGENERATE}.`,
    ).toEqual([]);
  });

  it("emits every code it registers", () => {
    const orphaned = Object.keys(registry.codes)
      .filter((code) => !emitted.has(code))
      .sort();
    expect(
      orphaned,
      `${REGISTRY_PATH} lists codes nothing emits any more. Removing a code breaks whoever ` +
        `was matching on it, so it must be deliberate: confirm the removal is intended and ` +
        `${REGENERATE}.`,
    ).toEqual([]);
  });

  it("never loses an assertion a code already had", () => {
    const regressed = Object.entries(registry.codes)
      .filter(([code, entry]) => entry.asserted && !isAsserted(code))
      .map(([code]) => code)
      .sort();
    expect(
      regressed,
      `These codes had a test naming them and no longer do. The string is a contract; ` +
        `losing its only assertion means a rename would now go unnoticed.`,
    ).toEqual([]);
  });

  it("banks assertions instead of leaving them unrecorded", () => {
    const improved = Object.entries(registry.codes)
      .filter(([code, entry]) => !entry.asserted && isAsserted(code))
      .map(([code]) => code)
      .sort();
    expect(
      improved,
      `These codes gained an assertion. Record it — ${REGENERATE} — so the coverage floor ` +
        `rises with the work rather than staying where it was.`,
    ).toEqual([]);
  });

  it("records which package owns each code", () => {
    const drifted = Object.entries(registry.codes)
      .filter(([code, entry]) => {
        const actual = [...(emitted.get(code) ?? [])].sort();
        return actual.join(",") !== [...entry.packages].sort().join(",");
      })
      .map(([code]) => code)
      .sort();
    expect(drifted, `Ownership moved for these codes — ${REGENERATE}.`).toEqual([]);
  });

  it("keeps its own headline counts honest", () => {
    const total = Object.keys(registry.codes).length;
    const asserted = Object.values(registry.codes).filter((entry) => entry.asserted).length;
    expect(registry.total, "registry.total").toBe(total);
    expect(registry.asserted, "registry.asserted").toBe(asserted);
    expect(registry.unasserted, "registry.unasserted").toBe(total - asserted);
  });
});
