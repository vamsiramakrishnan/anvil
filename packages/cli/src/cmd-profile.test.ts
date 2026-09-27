import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { airFromJson } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const spec = fileURLToPath(new URL("../../../examples/payments/openapi.yaml", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function compileWith(profileText: string, extra: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "anvil-profile-"));
  roots.push(root);
  const profile = join(root, "profile.yaml");
  writeFileSync(profile, profileText);
  const bundle = join(root, "bundle");
  const io = bufferIO();
  const code = await runAnvilCli(
    [
      "compile",
      spec,
      "--service",
      "payments",
      "--profile",
      profile,
      "--out",
      bundle,
      "--root",
      join(root, "sources"),
      ...extra,
    ],
    { io },
  );
  return { code, io, bundle, root };
}

const air = (bundle: string) => airFromJson(readFileSync(join(bundle, "air.json"), "utf8"));

describe("anvil compile --profile", () => {
  it("compiles only the selected operations and reports the profile", async () => {
    const { code, io, bundle } = await compileWith(
      "profile: payments-reads\nselect:\n  - method: get\n",
    );
    expect(code, io.text()).toBe(0);
    expect(io.text()).toMatch(/profile payments-reads .*: 2 of 4 source operations exposed/);
    const compiled = air(bundle);
    expect(compiled.operations.map((op) => op.sourceRef.operationId).sort()).toEqual([
      "getCustomer",
      "getPayment",
    ]);
    expect(compiled.service.source.profile?.sourceOperations).toBe(4);
  });

  it("refuses an invalid profile before compiling anything", async () => {
    const { code, io } = await compileWith("profile: Bad Id\nselect: some\n", ["--json"]);
    expect(code).toBe(1);
    expect(io.text()).toContain("profile/invalid");
  });

  it("refuses a profile pinned to a different source", async () => {
    const { code, io } = await compileWith(
      `profile: pinned\nselect: all\nsource:\n  digest: sha256:${"a".repeat(64)}\n`,
    );
    expect(code).toBe(1);
    expect(io.text()).toContain("pinned to source");
  });
});

describe("anvil approve --profile", () => {
  it("approves the profile's pending operations under a named reviewer and records the digest", async () => {
    const { code, io, bundle } = await compileWith(
      "profile: payments-all\nselect: all\nunexposed: compile\n",
    );
    expect(code, io.text()).toBe(0);
    const before = air(bundle);
    const digest = before.service.source.profile?.digest ?? "";

    const unnamed = bufferIO();
    expect(await runAnvilCli(["approve", bundle, "--profile"], { io: unnamed })).toBe(1);
    expect(unnamed.text()).toContain("--reviewer");

    const approve = bufferIO();
    const approved = await runAnvilCli(
      ["approve", bundle, "--profile", "--reviewer", "alice@example.test"],
      { io: approve },
    );
    expect(approved, approve.text()).toBe(0);
    const after = air(bundle);
    const pending = before.operations.filter(
      (op) => op.state !== "approved" && op.state !== "blocked",
    );
    for (const op of pending) {
      expect(after.operations.find((o) => o.id === op.id)?.state).toBe("approved");
    }
    const record = readFileSync(join(bundle, ".anvil", "approvals.jsonl"), "utf8").trim();
    const last = JSON.parse(record.split("\n").pop() ?? "{}");
    expect(last.reviewer).toBe("alice@example.test");
    expect(last.note).toContain(digest);
  });

  it("refuses to approve an operation outside the profile", async () => {
    const { code, io, bundle } = await compileWith(
      "profile: payments-reads\nselect:\n  - method: get\nunexposed: compile\n",
    );
    expect(code, io.text()).toBe(0);
    const outside = air(bundle).operations.find((op) => op.sourceRef.method !== "get");
    const refused = bufferIO();
    const result = await runAnvilCli(["approve", bundle, outside?.id ?? ""], { io: refused });
    expect(result).toBe(1);
    expect(refused.text()).toContain("outside exposure profile");
  });
});
