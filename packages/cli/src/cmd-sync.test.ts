import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DriftRecord } from "@anvil/compiler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const paymentsSpec = readFileSync(join(examples, "payments/openapi.yaml"), "utf8");

let root: string;
let spec: string;
let bundle: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "anvil-sync-"));
  spec = join(root, "spec", "openapi.yaml");
  bundle = join(root, "bundle");
  mkdirSync(join(root, "spec"), { recursive: true });
  writeFileSync(spec, paymentsSpec, "utf8");
  // The stored contract every sync diffs against. Lock into a separate
  // workspace so the snapshot store `sync` manages starts empty.
  const io = bufferIO();
  expect(
    await runAnvilCli(["compile", spec, "--out", bundle, "--root", join(root, "compile-ws")], {
      io,
    }),
  ).toBe(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Run `anvil sync` against the temp workspace. */
async function sync(...extra: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(["sync", spec, bundle, "--root", root, ...extra], { io });
  return { code, io };
}

/** Just enough of the OpenAPI fixture's shape to mutate it surgically. */
interface FixtureDoc {
  paths: Record<
    string,
    | {
        post?: {
          description?: string;
          requestBody?: {
            content: Record<string, { schema: { required?: string[] } } | undefined>;
          };
        };
      }
    | undefined
  >;
}

/** Fail loudly if the fixture's shape drifted from what a mutation expects. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("payments fixture shape changed");
  return value;
}

/** Rewrite the spec file with a structural mutation applied. */
function mutateSpec(mutate: (doc: FixtureDoc) => void): void {
  const doc = parseYaml(readFileSync(spec, "utf8")) as FixtureDoc;
  mutate(doc);
  writeFileSync(spec, toYaml(doc), "utf8");
}

/** Delete GET /customers/{customer_id} — the canonical operation removal. */
function removeCustomersGet(doc: FixtureDoc): void {
  delete doc.paths["/customers/{customer_id}"];
}

/** The refund POST operation — the mutation hot spot. */
function refundPost(doc: FixtureDoc) {
  return must(must(doc.paths["/payments/{payment_id}/refunds"]).post);
}

describe("anvil sync", () => {
  it("reports no drift for an unchanged spec and reuses the same source hash", async () => {
    const first = await sync();
    expect(first.code).toBe(0);
    expect(first.io.text()).toContain("No semantic drift");
    const hash = first.io.text().match(/sha256:[0-9a-f]{64}/)?.[0];
    expect(hash).toBeDefined();

    // Second run takes the snapshot fast path: same content, same hash, no compile.
    const second = await sync();
    expect(second.code).toBe(0);
    expect(second.io.text()).toContain("Source unchanged");
    expect(second.io.text()).toContain(hash as string);
    // Exactly one snapshot was locked; no drift record was written.
    expect(readdirSync(join(root, ".anvil", "sources"))).toHaveLength(1);
  });

  it("detects drift, writes a record, and exits non-zero on high/blocking items", async () => {
    mutateSpec((doc) => {
      removeCustomersGet(doc);
      must(must(refundPost(doc).requestBody).content["application/json"]).schema.required = [
        "amount",
        "currency",
        "reason",
      ];
    });
    const { code, io } = await sync("--json");
    expect(code).toBe(1); // operation_removed is high — gate the pipeline
    const { record } = JSON.parse(io.stdout.join("\n")) as { record: DriftRecord };
    expect(record.items.map((i) => i.kind).sort()).toEqual([
      "field_requiredness_changed",
      "operation_removed",
    ]);
    expect(record.affectedCapabilityIds).toEqual([
      "payments_api.customers",
      "payments_api.refunds",
    ]);
    expect(record.previousSourceHash).toBeUndefined(); // spec was never source-added before
    // The record is on disk under .anvil/drift/<id>.json.
    const stored = JSON.parse(
      readFileSync(join(root, ".anvil", "drift", `${record.id}.json`), "utf8"),
    );
    expect(stored.id).toBe(record.id);
  });

  it("doc-only drift is info-level and does not gate", async () => {
    mutateSpec((doc) => {
      refundPost(doc).description = "Creates a refund. This cannot be undone.";
    });
    const { code, io } = await sync("--json");
    expect(code).toBe(0);
    const { record } = JSON.parse(io.stdout.join("\n")) as { record: DriftRecord };
    expect(record.items).toHaveLength(1);
    expect(record.items[0]?.severity).toBe("info");
    expect(record.invalidatedCertifications).toEqual([]); // prose never re-earns a cert
  });

  it("reports the source hash transition once a prior snapshot exists", async () => {
    const io0 = bufferIO();
    expect(await runAnvilCli(["source", "add", spec, "--root", root], { io: io0 })).toBe(0);
    mutateSpec((doc) => {
      removeCustomersGet(doc);
    });
    const { io } = await sync();
    expect(io.text()).toMatch(/Source hash: sha256:[0-9a-f]{64} → sha256:[0-9a-f]{64}/);
  });

  it("flags certifications invalidated by material drift", async () => {
    const io0 = bufferIO();
    await runAnvilCli(["certify", bundle], { io: io0 }); // writes certification.json
    mutateSpec((doc) => {
      removeCustomersGet(doc);
    });
    const { io } = await sync("--json");
    const { record } = JSON.parse(io.stdout.join("\n")) as { record: DriftRecord };
    expect(record.invalidatedCertifications).toHaveLength(1);
    expect(record.invalidatedCertifications[0]?.path).toBe("certification.json");
    expect(record.invalidatedCertifications[0]?.invalidatedBy).toEqual(
      record.items.map((i) => i.id).sort(),
    );
  });

  it("never mutates the stored AIR or the spec", async () => {
    const airBefore = readFileSync(join(bundle, "air.yaml"), "utf8");
    mutateSpec((doc) => {
      removeCustomersGet(doc);
    });
    const specText = readFileSync(spec, "utf8");
    await sync();
    expect(readFileSync(join(bundle, "air.yaml"), "utf8")).toBe(airBefore);
    expect(readFileSync(spec, "utf8")).toBe(specText);
  });

  it("re-syncing changed-but-already-locked content takes the fast path and points at the record", async () => {
    mutateSpec((doc) => {
      removeCustomersGet(doc);
    });
    const first = await sync("--json");
    const { record } = JSON.parse(first.io.stdout.join("\n")) as { record: DriftRecord };
    const second = await sync();
    expect(second.code).toBe(0);
    expect(second.io.text()).toContain("Source unchanged");
    expect(second.io.text()).toContain(record.id); // the unreviewed record is surfaced
  });

  it("is deterministic: the same drift always lands in the same record", async () => {
    mutateSpec((doc) => {
      removeCustomersGet(doc);
    });
    const first = await sync("--json");
    const { record: a } = JSON.parse(first.io.stdout.join("\n")) as { record: DriftRecord };
    // Remove the locked snapshot so the second run recomputes from scratch.
    rmSync(join(root, ".anvil", "sources"), { recursive: true, force: true });
    const second = await sync("--json");
    const { record: b } = JSON.parse(second.io.stdout.join("\n")) as { record: DriftRecord };
    expect(b.id).toBe(a.id);
    expect(b.items.map((i) => i.id)).toEqual(a.items.map((i) => i.id));
    // One record on disk, not two.
    expect(readdirSync(join(root, ".anvil", "drift"))).toHaveLength(1);
  });
});
