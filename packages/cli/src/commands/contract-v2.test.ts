import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { CAPABILITY_FEATURES } from "../capabilities.js";
import { bufferIO } from "../io.js";
import { LEAN_SKILL_MAX_BYTES, leanSkillMd } from "./harness-package.js";
import { buildLayout, checkLayout, pushLayout, writeLayout } from "./package-oci.js";

/**
 * Branchyard's Anvil contract v2, items 3 (search index, lean skill), 4 (host
 * install, OCI layout) and 8 (connector icon). Hermetic: no registry, no
 * network beyond a loopback server this file starts.
 */

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const BRANCHYARD_TOOLS =
  "/home/user/branchyard/plugins/branchyard/skills/find-tools/scripts/tools.py";
const PYTHON = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
let work = "";
let github = "";
let iconed = "";

async function anvil(args: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(args, { io });
  return { code, io };
}

async function compileGithub(out: string, icon?: string) {
  const manifest = join(work, `anvil-${icon ?? "plain"}.yaml`.replace(/[^\w.-]/g, "_"));
  const text = readFileSync(join(examples, "github-mini", "anvil.yaml"), "utf8");
  writeFileSync(
    manifest,
    icon === undefined
      ? text
      : text.replace("  display_name: GitHub Mini", `  display_name: GitHub Mini\n  icon: ${icon}`),
  );
  return anvil([
    "compile",
    join(examples, "github-mini", "openapi.yaml"),
    "--manifest",
    manifest,
    "--out",
    out,
  ]);
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "anvil-contract-v2-"));
  github = join(work, "ws", "github");
  iconed = join(work, "ws-icon", "github");
  const plain = await compileGithub(github);
  if (plain.code !== 0) throw new Error(plain.io.text());
  const withIcon = await compileGithub(iconed, "github");
  if (withIcon.code !== 0) throw new Error(withIcon.io.text());
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Branchyard's rules for `search.json` (docs/anvil-contract-v2.md, "the fields, pinned"), as a validator. */
function pinnedProblems(
  data: Record<string, unknown>,
  connector: string,
  packageDir: string,
): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  need(data.schema === "anvil.search/v1", "schema");
  need(data.connector === connector, "connector");
  need(/^sha256:[0-9a-f]{64}$/.test(String(data.bundle_hash)), "bundle_hash");
  need("icon" in data, "icon present");
  need(
    data.icon === null ||
      (typeof data.icon === "string" &&
        data.icon.length <= 64 &&
        /^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.icon)),
    "icon slug",
  );
  const operations = data.operations as Record<string, unknown>[];
  need(Array.isArray(operations), "operations");
  let previous = "";
  for (const op of operations) {
    const at = String(op.id);
    need(
      new RegExp(`^${connector}(\\.[A-Za-z0-9_-]+)+$`).test(at) && at > previous,
      `${at}: id unique and sorted`,
    );
    previous = at;
    need(typeof op.title === "string" && op.title !== "", `${at}: title`);
    const summary = String(op.summary);
    need(summary !== "" && summary.length <= 160 && !/[\r\n]/.test(summary), `${at}: summary`);
    need(
      ["read", "reversible", "compensable", "irreversible"].includes(String(op.effect)),
      `${at}: effect`,
    );
    need(op.risk === null || (typeof op.risk === "string" && op.risk !== ""), `${at}: risk`);
    need(typeof op.confirm === "boolean", `${at}: confirm`);
    need(["safe", "keyed", "none"].includes(String(op.idempotency)), `${at}: idempotency`);
    need(typeof op.resource === "string" && op.resource !== "", `${at}: resource`);
    for (const field of ["tags", "terms"]) {
      const list = op[field] as unknown[];
      need(
        Array.isArray(list) && list.every((item) => typeof item === "string" && item !== ""),
        `${at}: ${field}`,
      );
    }
    need(
      (op.terms as string[]).every((term) => /^[a-z0-9]+$/.test(term)),
      `${at}: terms are lower case`,
    );
    const schema = String(op.schema);
    need(
      !schema.startsWith("/") &&
        !schema.split("/").includes("..") &&
        existsSync(join(packageDir, schema)),
      `${at}: schema path`,
    );
    need(typeof op.cli === "string" && op.cli !== "", `${at}: cli`);
  }
  return problems;
}

describe("search.json (item 3)", () => {
  it("lists every approved operation once, with the pinned fields and a schema file each", async () => {
    const out = join(work, "p-full");
    const { code, io } = await anvil(["package", "harness", github, "--out", out]);
    expect(code, io.text()).toBe(0);
    const search = JSON.parse(readFileSync(join(out, "search.json"), "utf8"));
    expect(pinnedProblems(search, "github", out)).toEqual([]);
    const harness = JSON.parse(readFileSync(join(out, "harness.json"), "utf8"));
    expect(search.operations).toHaveLength(harness.operations.length);
    expect(search.operations.map((op: { id: string }) => op.id)).toEqual(
      expect.arrayContaining([
        "github.issues.list",
        "github.comments.create",
        "github.releases.create",
      ]),
    );
    const create = search.operations.find(
      (op: { id: string }) => op.id === "github.releases.create",
    );
    expect(create).toMatchObject({
      effect: "irreversible",
      confirm: true,
      cli: "bin/github releases create",
    });
    const list = search.operations.find((op: { id: string }) => op.id === "github.issues.list");
    expect(list).toMatchObject({ effect: "read", risk: null, confirm: false, idempotency: "safe" });
    expect(list.terms).toEqual(expect.arrayContaining(["issues", "list", "owner", "repo"]));
    const schema = JSON.parse(readFileSync(join(out, list.schema), "utf8"));
    expect(schema.required).toEqual(expect.arrayContaining(["owner", "repo"]));
    expect(search.bundle_hash).toBe(`sha256:${harness.bundleHash}`);
    expect(harness.bundle_hash).toBe(search.bundle_hash);
    const shipped = JSON.parse(readFileSync(join(out, "schemas", "anvil-search-v1.json"), "utf8"));
    expect(shipped.properties.schema.const).toBe("anvil.search/v1");
  });

  it("keeps pending operations out of the index", async () => {
    const pending = join(work, "ws-pending", "github");
    const manifest = join(work, "anvil-pending.yaml");
    writeFileSync(
      manifest,
      readFileSync(join(examples, "github-mini", "anvil.yaml"), "utf8").replace(
        "  getIssue:\n    name: { resource: issues, verb: get }\n    state: approved",
        "  getIssue:\n    name: { resource: issues, verb: get }",
      ),
    );
    const compiled = await anvil([
      "compile",
      join(examples, "github-mini", "openapi.yaml"),
      "--manifest",
      manifest,
      "--out",
      pending,
    ]);
    expect(compiled.code, compiled.io.text()).toBe(0);
    const out = join(work, "p-pending");
    expect((await anvil(["package", "harness", pending, "--out", out])).code).toBe(0);
    const ids = JSON.parse(readFileSync(join(out, "search.json"), "utf8")).operations.map(
      (op: { id: string }) => op.id,
    );
    expect(ids).not.toContain("github.issues.get");
    expect(ids).toContain("github.issues.list");
    expect(existsSync(join(out, "schemas", "github.issues.get.input.json"))).toBe(false);
  });

  it("gives the same bytes for the same bundle", async () => {
    const a = join(work, "p-det-a");
    const b = join(work, "p-det-b");
    for (const out of [a, b]) {
      expect(
        (await anvil(["package", "harness", github, "--out", out, "--skill-mode", "lean"])).code,
      ).toBe(0);
    }
    const files = (root: string, rel = ""): string[] =>
      readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(root, join(rel, entry.name)) : [join(rel, entry.name)],
      );
    const names = files(a).sort();
    expect(files(b).sort()).toEqual(names);
    for (const name of names) {
      expect(readFileSync(join(b, name)).equals(readFileSync(join(a, name))), name).toBe(true);
    }
  });

  it("the full skill is the default and lists the operations; a bad mode is refused", async () => {
    const out = join(work, "p-mode");
    expect((await anvil(["package", "harness", github, "--out", out])).code).toBe(0);
    expect(readFileSync(join(out, "SKILL.md"), "utf8")).toContain("| CLI | Python method |");
    const refused = await anvil([
      "package",
      "harness",
      github,
      "--out",
      join(work, "p-bad"),
      "--skill-mode",
      "tiny",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.io.text()).toContain("--skill-mode is full or lean");
    expect(existsSync(join(work, "p-bad"))).toBe(false);
  });
});

describe("lean SKILL.md (item 3)", () => {
  it("is at most 4 KB for the largest example bundle and points at search.json", async () => {
    const out = join(work, "p-lean");
    expect(
      (await anvil(["package", "harness", github, "--out", out, "--skill-mode", "lean"])).code,
    ).toBe(0);
    const skill = readFileSync(join(out, "SKILL.md"), "utf8");
    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(4096);
    expect(skill).toMatch(/^---\nname: github\ndescription: /);
    expect(skill).toContain("search.json");
    expect(skill).toContain("reference/operations.md");
    expect(skill).toMatch(/- `github\.issue`.*: \d+ operations?/);
    expect(skill).not.toContain("| CLI | Python method |");
    expect(existsSync(join(out, "reference", "operations.md"))).toBe(true);
  });

  it("stays under 4 KB however many capabilities a bundle has", () => {
    const air = {
      service: { id: "big", displayName: "Big ".repeat(200), version: "1" },
      operations: [],
      capabilities: Array.from({ length: 600 }, (_, i) => ({
        id: `big.capability_number_${i}`,
        displayName: `Capability ${i} `.repeat(10),
      })),
    } as unknown as AirDocument;
    const operations = air.capabilities.map((capability) => ({ resource: capability.id }));
    const skill = leanSkillMd(air, "big", { operations } as never);
    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(LEAN_SKILL_MAX_BYTES);
    expect(skill).toMatch(/- \.\.\. and \d+ more capabilities: see `search\.json`\n$/);
  });
});

describe("connector icon (item 8)", () => {
  it("is null everywhere when the bundle has none", async () => {
    const out = join(work, "p-noicon");
    expect((await anvil(["package", "harness", github, "--out", out])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "search.json"), "utf8")).icon).toBeNull();
    expect(JSON.parse(readFileSync(join(out, "harness.json"), "utf8")).icon).toBeNull();
  });

  it("appears in harness.json, search.json and the connector index", async () => {
    const out = join(work, "p-icon", "github");
    expect((await anvil(["package", "harness", iconed, "--out", out])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "search.json"), "utf8")).icon).toBe("github");
    expect(JSON.parse(readFileSync(join(out, "harness.json"), "utf8")).icon).toBe("github");
    const grants = join(work, "grants.json");
    writeFileSync(
      grants,
      JSON.stringify([{ connector: "github", operations: ["*"], mode: "read" }]),
    );
    const index = join(work, "p-icon", "INDEX.md");
    const done = await anvil(["connectors", "index", "--grants", grants, "--out", index, iconed]);
    expect(done.code, done.io.text()).toBe(0);
    expect(readFileSync(index, "utf8")).toContain("- **Icon:** `github`");
  });

  it("the index says none for a bundle without an icon", async () => {
    const grants = join(work, "grants2.json");
    writeFileSync(
      grants,
      JSON.stringify([{ connector: "github", operations: ["*"], mode: "read" }]),
    );
    const index = join(work, "INDEX-none.md");
    expect(
      (await anvil(["connectors", "index", "--grants", grants, "--out", index, github])).code,
    ).toBe(0);
    expect(readFileSync(index, "utf8")).toContain("- **Icon:** none");
  });

  it.each([
    "GitHub",
    "git hub",
    "-github",
    "github-",
    "a--b",
    "x".repeat(65),
  ])("refuses %j at compile time and names the field", async (icon) => {
    const result = await compileGithub(join(work, "ws-bad", "github"), JSON.stringify(icon));
    expect(result.code).not.toBe(0);
    expect(result.io.text()).toContain("icon");
    expect(existsSync(join(work, "ws-bad", "github", "air.yaml"))).toBe(false);
  });

  it("accepts a slug that no sprite holds", async () => {
    const result = await compileGithub(join(work, "ws-odd", "github"), "some-unknown-brand-2");
    expect(result.code, result.io.text()).toBe(0);
  });
});

describe("anvil capabilities", () => {
  it("lists exactly the features this tree implements", async () => {
    const { code, io } = await anvil(["capabilities", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({ features: [...CAPABILITY_FEATURES].sort() });
    for (const feature of [
      "bundle.icon",
      "install.prefix",
      "package.oci",
      "package.search",
      "skill.lean",
    ]) {
      expect(CAPABILITY_FEATURES).toContain(feature);
    }
  });
});

describe("Branchyard's reader on a real package (cross-check)", () => {
  // Runs Branchyard's own `tools.py` over a package this `anvil package harness`
  // wrote. Skipped when a Branchyard checkout is not at the usual path; the
  // `pinnedProblems` validator above is the same rules copied into this file.
  it.skipIf(!PYTHON || !existsSync(BRANCHYARD_TOOLS))(
    "tools.py reads the package and ranks an operation",
    async () => {
      const tree = join(work, "tree");
      mkdirSync(join(tree, "connectors"), { recursive: true });
      expect(
        (await anvil(["package", "harness", iconed, "--out", join(tree, "connectors", "github")]))
          .code,
      ).toBe(0);
      const run = (...args: string[]) =>
        spawnSync("python3", ["-I", BRANCHYARD_TOOLS, "--root", tree, ...args], {
          encoding: "utf8",
        });
      const found = run("search", "list", "issues");
      expect(found.status, found.stderr).toBe(0);
      expect(found.stdout).toContain("github.issues.list");
      const schema = run("schema", "github.issues.list");
      expect(schema.status, schema.stderr).toBe(0);
      expect(JSON.parse(schema.stdout).required).toEqual(expect.arrayContaining(["owner", "repo"]));
    },
  );
});

/** A toolchain source directory: manifest.json plus the files it lists. */
function toolchain(root: string, files: Record<string, string>): string {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      files: Object.fromEntries(
        Object.entries(files).map(([n, b]) => [n, createHash("sha256").update(b).digest("hex")]),
      ),
    }),
  );
  return root;
}

describe("anvil install --prefix (item 4)", () => {
  const files = {
    "bin/anvil": "#!/bin/sh\necho anvil\n",
    "python/anvil_sdk/__init__.py": "VERSION = 'x'\n",
  };

  it("lays out a version, switches current by rename, and a second run changes nothing", async () => {
    const prefix = join(work, "opt-a");
    const source = toolchain(join(work, "src-a"), files);
    const first = await anvil(["install", "--prefix", prefix, "--from", source]);
    expect(first.code, first.io.text()).toBe(0);
    const target = readlinkSync(join(prefix, "current"));
    expect(target).toMatch(/^versions\/[0-9a-f]{64}$/);
    for (const name of ["manifest.json", "bin/anvil", "python/anvil_sdk/__init__.py", "env.sh"]) {
      expect(existsSync(join(prefix, "current", name)), name).toBe(true);
    }
    expect(statSync(join(prefix, "current", "bin", "anvil")).mode & 0o111).not.toBe(0);
    const manifest = join(prefix, "current", "manifest.json");
    const old = new Date(2020, 0, 1);
    utimesSync(manifest, old, old);
    const before = statSync(manifest).mtimeMs;
    const second = await anvil(["install", "--prefix", prefix, "--from", source]);
    expect(second.code).toBe(0);
    expect(statSync(manifest).mtimeMs).toBe(before);
    expect(readlinkSync(join(prefix, "current"))).toBe(target);
    expect(readdirSync(join(prefix, "versions"))).toHaveLength(1);
  });

  it("names the version by the digest of the file map, as Branchyard's mock does", async () => {
    const prefix = join(work, "opt-digest");
    await anvil([
      "install",
      "--prefix",
      prefix,
      "--from",
      toolchain(join(work, "src-digest"), files),
    ]);
    const recorded = JSON.parse(
      readFileSync(join(prefix, "current", "manifest.json"), "utf8"),
    ).files;
    const pythonDumps = `{${Object.keys(recorded)
      .sort()
      .map((k) => `${JSON.stringify(k)}: ${JSON.stringify(recorded[k])}`)
      .join(", ")}}`;
    expect(readlinkSync(join(prefix, "current"))).toBe(
      `versions/${createHash("sha256").update(pythonDumps).digest("hex")}`,
    );
  });

  it("refuses a tampered file before anything is written, and names the path", async () => {
    const prefix = join(work, "opt-tamper");
    const source = toolchain(join(work, "src-tamper"), files);
    writeFileSync(join(source, "python/anvil_sdk/__init__.py"), "VERSION = 'evil'\n");
    const done = await anvil(["install", "--prefix", prefix, "--from", source]);
    expect(done.code).toBe(1);
    expect(done.io.text()).toContain("digest mismatch for python/anvil_sdk/__init__.py");
    expect(existsSync(prefix)).toBe(false);
  });

  it("refusing a tampered update leaves the installed version and current as they were", async () => {
    const prefix = join(work, "opt-keep");
    expect(
      (
        await anvil([
          "install",
          "--prefix",
          prefix,
          "--from",
          toolchain(join(work, "src-keep"), files),
        ])
      ).code,
    ).toBe(0);
    const before = readlinkSync(join(prefix, "current"));
    const bad = toolchain(join(work, "src-keep2"), { ...files, "bin/extra": "x" });
    writeFileSync(join(bad, "bin/extra"), "y");
    expect((await anvil(["install", "--prefix", prefix, "--from", bad])).code).toBe(1);
    expect(readlinkSync(join(prefix, "current"))).toBe(before);
    expect(readdirSync(join(prefix, "versions"))).toEqual([before.split("/")[1]]);
  });

  it("refuses a manifest path that leaves the version directory", async () => {
    const source = toolchain(join(work, "src-escape"), files);
    writeFileSync(
      join(source, "manifest.json"),
      JSON.stringify({ files: { "../escape": "0".repeat(64) } }),
    );
    const done = await anvil(["install", "--prefix", join(work, "opt-escape"), "--from", source]);
    expect(done.code).toBe(1);
    expect(existsSync(join(work, "opt-escape"))).toBe(false);
  });

  it("--prune removes versions that current does not name and keeps connectors/", async () => {
    const prefix = join(work, "opt-prune");
    expect(
      (
        await anvil([
          "install",
          "--prefix",
          prefix,
          "--from",
          toolchain(join(work, "src-p1"), files),
        ])
      ).code,
    ).toBe(0);
    mkdirSync(join(prefix, "connectors", "sha256-abc"), { recursive: true });
    const first = readlinkSync(join(prefix, "current"));
    const next = toolchain(join(work, "src-p2"), {
      ...files,
      "bin/anvil": "#!/bin/sh\necho two\n",
    });
    expect((await anvil(["install", "--prefix", prefix, "--from", next, "--prune"])).code).toBe(0);
    const second = readlinkSync(join(prefix, "current"));
    expect(second).not.toBe(first);
    expect(readdirSync(join(prefix, "versions"))).toEqual([second.split("/")[1]]);
    expect(existsSync(join(prefix, "connectors", "sha256-abc"))).toBe(true);
  });

  it("switches current without ever removing it (the link is renamed over)", async () => {
    const prefix = join(work, "opt-atomic");
    await anvil(["install", "--prefix", prefix, "--from", toolchain(join(work, "src-at1"), files)]);
    await anvil([
      "install",
      "--prefix",
      prefix,
      "--from",
      toolchain(join(work, "src-at2"), { ...files, "bin/anvil": "two" }),
    ]);
    expect(lstatSync(join(prefix, "current")).isSymbolicLink()).toBe(true);
    expect(readdirSync(prefix).sort()).toEqual(["current", "versions"]);
    expect(readdirSync(join(prefix, "versions"))).toHaveLength(2);
  });

  it.skipIf(!PYTHON)(
    "the built-in toolchain: env.sh makes the Python SDK importable and bin/anvil --version prints the digest",
    async () => {
      const prefix = join(work, "opt-builtin");
      const done = await anvil(["install", "--prefix", prefix]);
      expect(done.code, done.io.text()).toBe(0);
      const digest = JSON.parse(
        readFileSync(join(prefix, "current", "manifest.json"), "utf8"),
      ).digest;
      expect(done.io.text()).toContain(`anvil installed ${digest} under ${prefix}`);
      for (const dir of ["bin", "python", "typescript", "compose"]) {
        expect(existsSync(join(prefix, "current", dir)), dir).toBe(true);
      }
      const run = spawnSync(
        "sh",
        [
          "-c",
          `. "${prefix}/current/env.sh" && python3 -I -c "import sys; sys.path[:0]=['${prefix}/current/python','${prefix}/current/compose/python']; import anvil_sdk, anvil_compose; print(anvil_sdk.VERSION)" && anvil --version`,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("0.1.0");
      expect(run.stdout.trim().split("\n").at(-1)).toBe(`anvil ${digest}`);
      const again = await anvil(["install", "--prefix", prefix]);
      expect(again.code).toBe(0);
      expect(readdirSync(join(prefix, "versions"))).toHaveLength(1);
    },
  );

  it("refuses a missing --prefix", async () => {
    const done = await anvil(["install"]);
    expect(done.code).not.toBe(0);
    expect(done.io.text()).toContain("--prefix");
  });
});

describe("anvil package oci (item 4)", () => {
  let pkg = "";
  beforeAll(async () => {
    pkg = join(work, "oci-pkg", "github");
    expect((await anvil(["package", "harness", iconed, "--out", pkg])).code).toBe(0);
  }, 60_000);

  it("writes a layout that passes the OCI layout check, with one blob per file and the annotations", async () => {
    const out = join(work, "oci-a");
    const done = await anvil(["package", "oci", pkg, "--out", out]);
    expect(done.code, done.io.text()).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "oci-layout"), "utf8"))).toEqual({
      imageLayoutVersion: "1.0.0",
    });
    expect(checkLayout(out)).toEqual([]);
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
    const harness = JSON.parse(readFileSync(join(pkg, "harness.json"), "utf8"));
    expect(index.manifests).toHaveLength(1);
    for (const annotations of [index.annotations, index.manifests[0].annotations]) {
      expect(annotations).toEqual({
        "dev.anvil.bundle-hash": harness.bundle_hash,
        "dev.anvil.connector": "github",
        "dev.anvil.version": harness.service.version,
      });
    }
    const manifest = JSON.parse(
      readFileSync(join(out, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
    );
    const titles = manifest.layers.map(
      (layer: { annotations: Record<string, string> }) =>
        layer.annotations["org.opencontainers.image.title"],
    );
    expect(titles).toEqual(
      expect.arrayContaining(["SKILL.md", "search.json", "harness.json", "bin/github"]),
    );
    const bin = manifest.layers.find(
      (l: { annotations: Record<string, string> }) =>
        l.annotations["org.opencontainers.image.title"] === "bin/github",
    );
    expect(bin.annotations["dev.anvil.mode"]).toBe("755");
  });

  it("is deterministic, and a rerun into the same layout writes no new blob", async () => {
    const a = join(work, "oci-d1");
    const b = join(work, "oci-d2");
    await anvil(["package", "oci", pkg, "--out", a]);
    await anvil(["package", "oci", pkg, "--out", b]);
    expect(readFileSync(join(a, "index.json")).equals(readFileSync(join(b, "index.json")))).toBe(
      true,
    );
    const again = await anvil(["package", "oci", pkg, "--out", a]);
    expect(again.io.text()).toContain("0 new");
  });

  it("the check finds a corrupted blob", async () => {
    const out = join(work, "oci-bad");
    await anvil(["package", "oci", pkg, "--out", out]);
    const blob = join(
      out,
      "blobs",
      "sha256",
      readdirSync(join(out, "blobs", "sha256"))[0] as string,
    );
    chmodSync(blob, 0o644);
    writeFileSync(blob, "tampered");
    expect(checkLayout(out).join("\n")).toMatch(/does not hash to its name|bytes, not/);
  });

  it("refuses a directory that is not a harness package, and an --out that holds other files", async () => {
    const empty = join(work, "not-a-package");
    mkdirSync(empty);
    const refused = await anvil(["package", "oci", empty, "--out", join(work, "oci-x")]);
    expect(refused.code).toBe(1);
    expect(refused.io.text()).toContain("not a harness package");
    const busy = join(work, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "keep.txt"), "x");
    expect((await anvil(["package", "oci", pkg, "--out", busy])).code).toBe(1);
    expect(existsSync(join(busy, "keep.txt"))).toBe(true);
  });

  it("refuses a symbolic link in the package", async () => {
    const linked = join(work, "oci-link");
    cpSync(pkg, linked, { recursive: true });
    symlinkSync("/etc/hostname", join(linked, "leak"));
    const refused = await anvil(["package", "oci", linked, "--out", join(work, "oci-l")]);
    expect(refused.code).toBe(1);
    expect(refused.io.text()).toContain("symbolic link");
  });

  describe("push, against a registry on loopback", () => {
    let server: Server;
    let base = "";
    const blobs = new Map<string, Buffer>();
    const manifests = new Map<string, { digest: string; body: Buffer }>();
    const calls: string[] = [];
    let auth: string | undefined;

    beforeAll(async () => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks);
          const url = new URL(req.url ?? "/", "http://x");
          auth = req.headers.authorization;
          calls.push(`${req.method} ${url.pathname}`);
          const blob = /^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]+)$/.exec(url.pathname);
          const manifest = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname);
          if (blob && req.method === "HEAD") {
            res.statusCode = blobs.has(blob[2] as string) ? 200 : 404;
          } else if (/\/blobs\/uploads\/$/.test(url.pathname) && req.method === "POST") {
            res.statusCode = 202;
            res.setHeader("location", "/v2/up/session-1");
          } else if (url.pathname === "/v2/up/session-1" && req.method === "PUT") {
            const digest = url.searchParams.get("digest") ?? "";
            blobs.set(digest, body);
            res.statusCode = 201;
          } else if (manifest && req.method === "HEAD") {
            const held = manifests.get(manifest[2] as string);
            res.statusCode = held ? 200 : 404;
            if (held) res.setHeader("docker-content-digest", held.digest);
          } else if (manifest && req.method === "PUT") {
            manifests.set(manifest[2] as string, {
              digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
              body,
            });
            res.statusCode = 201;
          } else {
            res.statusCode = 400;
          }
          res.end();
        });
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      server.close();
      server.closeAllConnections();
    });

    it("uploads what is missing, then pushing the same digest again is a no-op", async () => {
      const layout = buildLayout(pkg);
      const first = await pushLayout(layout, `${base}/team/github:v1`, "secret-token");
      expect(first.manifestPushed).toBe(true);
      expect(first.uploaded).toBeGreaterThan(5);
      expect(auth).toBe("Bearer secret-token");
      expect(manifests.get("v1")?.digest).toBe(layout.manifest.digest);
      for (const digest of layout.blobs.keys()) {
        if (digest !== layout.manifest.digest) expect(blobs.has(digest), digest).toBe(true);
      }
      const seen = calls.length;
      const second = await pushLayout(layout, `${base}/team/github:v1`, undefined);
      expect(second).toEqual({ uploaded: 0, manifestPushed: false });
      expect(calls.slice(seen).every((call) => call.startsWith("HEAD"))).toBe(true);
    });

    it("a new tag with the blobs already there uploads none", async () => {
      const layout = buildLayout(pkg);
      const tagged = await pushLayout(layout, `${base}/team/github:v2`, undefined);
      expect(tagged).toEqual({ uploaded: 0, manifestPushed: true });
    });

    it("the command pushes with --push and reports it", async () => {
      const out = join(work, "oci-push");
      const done = await anvil([
        "package",
        "oci",
        pkg,
        "--out",
        out,
        "--push",
        `${base}/team/github:v3`,
      ]);
      expect(done.code, done.io.text()).toBe(0);
      expect(done.io.text()).toContain("Pushed");
      expect(manifests.has("v3")).toBe(true);
    });

    it("refuses a reference that is not host/repository", async () => {
      const done = await anvil([
        "package",
        "oci",
        pkg,
        "--out",
        join(work, "oci-ref"),
        "--push",
        "no-slash",
      ]);
      expect(done.code).toBe(1);
      expect(done.io.text()).toContain("is not <host>");
    });
  });

  it("round-trips through writeLayout without a clock", () => {
    const layout = buildLayout(pkg);
    const out = join(work, "oci-rt");
    expect(writeLayout(layout, out)).toBe(layout.blobs.size);
    expect(writeLayout(layout, out)).toBe(0);
  });
});
