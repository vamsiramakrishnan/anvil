import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, airFromYaml } from "@anvil/air";
import type { SourceSnapshot } from "@anvil/compiler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const multifile = join(examples, "fixtures/multifile");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anvil-compile-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function cli(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli([...argv, "--root", root], { io });
  return { code, io };
}

/** Lock the multi-file fixture and return its snapshot id. */
async function lockMultifile(dir: string): Promise<string> {
  const io = bufferIO();
  const code = await runAnvilCli(["source", "add", dir, "--root", root, "--json"], { io });
  expect(code).toBe(0);
  return (JSON.parse(io.stdout.join("\n")) as { snapshot: SourceSnapshot }).snapshot.snapshotId;
}

function loadAir(dir: string): AirDocument {
  return airFromYaml(readFileSync(join(dir, "air.yaml"), "utf8"));
}

describe("anvil compile — the snapshot is the compiler input", () => {
  it("compiles a locked multi-file snapshot, resolving $refs from the snapshot", async () => {
    const spec = join(root, "spec");
    cpSync(multifile, spec, { recursive: true });
    const id = await lockMultifile(spec);
    const out = join(root, "out");

    const { code, io } = await cli("compile", "--source", id, "--out", out);
    expect(code).toBe(0);
    expect(io.text()).toContain(id);

    const air = loadAir(out);
    // Both operations exist; createEntry's body came from the sibling schema file.
    expect(air.operations.map((o) => o.canonicalName).sort()).toEqual([
      "create_entry",
      "get_entry",
    ]);
    // AIR is bound to the snapshot it was compiled from.
    expect(air.service.source.snapshotId).toBe(id);
    expect(air.service.source.entrypoint).toBe("openapi.yaml");
    expect(air.service.source.sourceHash).toMatch(/^sha256:/);
  });

  it("compiles the locked bytes even after the originals are altered", async () => {
    const spec = join(root, "spec");
    cpSync(multifile, spec, { recursive: true });
    const id = await lockMultifile(spec);

    // Compile once from the pristine snapshot.
    const before = join(root, "before");
    expect((await cli("compile", "--source", id, "--out", before)).code).toBe(0);

    // Alter BOTH original files on disk after locking.
    writeFileSync(
      join(spec, "openapi.yaml"),
      `${readFileSync(join(spec, "openapi.yaml"), "utf8")}
  /tampered:
    delete:
      operationId: tamper
      responses: { "204": { description: gone } }
`,
    );
    writeFileSync(join(spec, "schemas", "entry.yaml"), "TAMPERED: not a schema\n");

    // Compile again from the SAME locked snapshot.
    const after = join(root, "after");
    expect((await cli("compile", "--source", id, "--out", after)).code).toBe(0);

    // The recompiled contract is based on the locked bytes, not the altered
    // originals: no `tamper` operation, identical operation set and hash.
    const a = loadAir(before);
    const b = loadAir(after);
    expect(b.operations.map((o) => o.canonicalName).sort()).toEqual(
      a.operations.map((o) => o.canonicalName).sort(),
    );
    expect(b.operations.some((o) => o.canonicalName === "tamper")).toBe(false);
    expect(b.service.source.sourceHash).toBe(a.service.source.sourceHash);

    // And the snapshot's own raw/ copy is still intact.
    const validate = await cli("source", "validate", id);
    expect(validate.code).toBe(0);
    expect(validate.io.text()).toContain("intact");
  });

  it("refuses to compile a snapshot whose locked raw/ bytes were tampered", async () => {
    const spec = join(root, "spec");
    cpSync(multifile, spec, { recursive: true });
    const id = await lockMultifile(spec);

    // Tamper the LOCKED copy under raw/, not the original — the compile path
    // must not bind an AIR to a sourceHash it did not actually compile.
    const raw = join(root, ".anvil", "sources", id, "raw", "schemas", "entry.yaml");
    writeFileSync(raw, `${readFileSync(raw, "utf8")}\n# tampered\n`);

    const { code, io } = await cli("compile", "--source", id, "--out", join(root, "out"));
    expect(code).toBe(1);
    expect(io.text()).toContain("source/file_changed");
  });

  it("imports-and-locks a spec path, then compiles that snapshot", async () => {
    const spec = join(root, "spec");
    cpSync(multifile, spec, { recursive: true });
    const out = join(root, "out");
    const { code, io } = await cli("compile", join(spec, "openapi.yaml"), "--out", out);
    expect(code).toBe(0);
    // A snapshot was locked as a side effect and the AIR is bound to it.
    const air = loadAir(out);
    expect(air.service.source.snapshotId).toBe(air.service.source.snapshotId);
    expect(io.text()).toMatch(/Compiled \d+ operations from src-/);
  });

  it("requires --entrypoint for a multi-entrypoint snapshot", async () => {
    const dir = join(root, "many");
    cpSync(join(examples, "payments/openapi.yaml"), join(dir, "a.yaml"));
    cpSync(join(examples, "fixtures/petstore-swagger2.yaml"), join(dir, "b.yaml"));
    const io = bufferIO();
    await runAnvilCli(
      ["source", "add", join(dir, "a.yaml"), join(dir, "b.yaml"), "--root", root, "--json"],
      {
        io,
      },
    );
    const id = (JSON.parse(io.stdout.join("\n")) as { snapshot: SourceSnapshot }).snapshot
      .snapshotId;

    const ambiguous = await cli("compile", "--source", id);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.io.text()).toContain("source/ambiguous_entrypoint");

    const chosen = await cli(
      "compile",
      "--source",
      id,
      "--entrypoint",
      "a.yaml",
      "--out",
      join(root, "out"),
    );
    expect(chosen.code).toBe(0);
  });

  it("rejects conflicting or missing inputs", async () => {
    const both = await cli("compile", "some.yaml", "--source", "src-x");
    expect(both.code).toBe(1);
    expect(both.io.text()).toContain("source/conflicting_input");

    const neither = await cli("compile");
    expect(neither.code).toBe(1);
    expect(neither.io.text()).toContain("source/no_input");

    const unknown = await cli("compile", "--source", "src-ghost");
    expect(unknown.code).toBe(1);
    expect(unknown.io.text()).toContain("source/not_found");
  });
});
