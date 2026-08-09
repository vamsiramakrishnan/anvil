import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The bug-bash manifest is only worth having if it cannot drift from the tests it
 * describes. These checks are what make it a convention rather than a document:
 * a new `*.bugbash.test.ts` file that nobody registers fails the build, and a
 * registered path that no longer exists fails it too.
 *
 * See docs/bug-bash/TAXONOMY.md for what the fields mean.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const MANIFEST_PATH = "docs/bug-bash/manifest.json";

interface Suite {
  path: string;
  subsystem: string;
  categories: string[];
}

interface Finding {
  id: string;
  package: string;
  subsystem: string;
  categories: string[];
  invariant: string;
  reproducer: string;
  disposition: string;
  whyMissed: string;
  regressionTest: string;
  status: string;
  seed?: number;
  fixture?: string;
  notes?: string;
}

interface Manifest {
  categories: string[];
  suites: Suite[];
  findings: Finding[];
}

const manifest: Manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8"));

const DISPOSITIONS = ["product", "test", "infrastructure", "documentation"];
const STATUSES = ["fixed", "open", "deferred"];

function bugbashFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".bugbash.test.ts")) found.push(full.slice(root.length));
    }
  };
  walk(join(root, "packages"));
  return found.sort();
}

describe("bug-bash manifest", () => {
  it("registers every bug-bash suite in the workspace", () => {
    const onDisk = bugbashFiles();
    const registered = manifest.suites.map((s) => s.path).sort();
    expect(
      onDisk.filter((p) => !registered.includes(p)),
      `Unregistered bug-bash suites. Add them to ${MANIFEST_PATH} with a subsystem and ` +
        `categories, so a sweep can be said to have covered something specific.`,
    ).toEqual([]);
    expect(
      registered.filter((p) => !onDisk.includes(p)),
      `${MANIFEST_PATH} names suites that no longer exist.`,
    ).toEqual([]);
  });

  it("gives every suite a subsystem and known categories", () => {
    for (const suite of manifest.suites) {
      expect(suite.subsystem.length, `${suite.path} needs a subsystem`).toBeGreaterThan(0);
      expect(suite.categories.length, `${suite.path} needs at least one category`).toBeGreaterThan(
        0,
      );
      for (const category of suite.categories) {
        expect(manifest.categories, `${suite.path} uses unknown category '${category}'`).toContain(
          category,
        );
      }
    }
  });

  it("gives every finding the fields that make it actionable", () => {
    const ids = new Set<string>();
    for (const finding of manifest.findings) {
      expect(ids.has(finding.id), `duplicate finding id '${finding.id}'`).toBe(false);
      ids.add(finding.id);

      for (const field of [
        "package",
        "subsystem",
        "invariant",
        "reproducer",
        "whyMissed",
        "regressionTest",
      ] as const) {
        expect(
          (finding[field] ?? "").length,
          `finding '${finding.id}' is missing ${field}`,
        ).toBeGreaterThan(0);
      }
      expect(DISPOSITIONS, `finding '${finding.id}' disposition`).toContain(finding.disposition);
      expect(STATUSES, `finding '${finding.id}' status`).toContain(finding.status);
      expect(finding.categories.length, `finding '${finding.id}' needs a category`).toBeGreaterThan(
        0,
      );
      for (const category of finding.categories) {
        expect(
          manifest.categories,
          `finding '${finding.id}' uses unknown category '${category}'`,
        ).toContain(category);
      }
    }
  });

  it("points every finding at a regression test that exists", () => {
    for (const finding of manifest.findings) {
      expect(
        () => statSync(join(root, finding.regressionTest)),
        `finding '${finding.id}' names a regression test that is not on disk: ${finding.regressionTest}`,
      ).not.toThrow();
    }
  });

  it("keeps the taxonomy document and the manifest categories in step", () => {
    const doc = readFileSync(join(root, "docs/bug-bash/TAXONOMY.md"), "utf8");
    for (const category of manifest.categories) {
      expect(doc, `TAXONOMY.md does not describe category '${category}'`).toContain(
        `\`${category}\``,
      );
    }
  });
});
