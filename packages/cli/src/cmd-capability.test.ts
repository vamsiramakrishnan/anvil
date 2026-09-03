import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, airFromYaml, airToYaml } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { JsonlRecordSpool } from "@anvil/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

/** A spec with `count` read operations under one tag (tool-budget scenarios). */
function specWithOps(count: number): string {
  const paths = Array.from({ length: count }, (_, i) =>
    [
      `  /things${i}:`,
      "    get:",
      `      operationId: getThing${i}`,
      "      tags: [things]",
      '      responses: { "200": { description: ok } }',
    ].join("\n"),
  ).join("\n");
  return `openapi: 3.0.0\ninfo: { title: things, version: 1.0.0 }\npaths:\n${paths}\n`;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anvil-cap-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function writePaymentsAir(): Promise<AirDocument> {
  const air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  writeBundle(dir, generateBundle(air));
  return air;
}

const reload = (): AirDocument => airFromYaml(readFileSync(join(dir, "air.yaml"), "utf8"));

describe("anvil capability", () => {
  it("prints local subcommand usage for a bare `anvil capability`", async () => {
    const io = bufferIO();
    expect(await runAnvilCli(["capability"], { io })).toBe(0);
    expect(io.text()).toContain("Usage: anvil capability");
    expect(io.text()).toMatch(/propose \[options\] <path>/);
    expect(io.text()).toMatch(/approve \[options\] <path> <capability-id>/);
    // Local help only: no sibling top-level commands leak in.
    expect(io.text()).not.toContain("agentify");
  });

  it("propose prints groupings with provenance and stays read-only", async () => {
    await writePaymentsAir();
    const before = readFileSync(join(dir, "air.yaml"), "utf8");
    const io = bufferIO();
    expect(await runAnvilCli(["capability", "propose", dir], { io })).toBe(0);
    expect(io.text()).toContain("payments.refunds");
    expect(io.text()).toMatch(/OpenAPI tag "refunds"/); // provenance, not just a name
    expect(io.text()).toMatch(/confidence 0\.90/);
    expect(io.text()).toContain("proposed");
    expect(readFileSync(join(dir, "air.yaml"), "utf8")).toBe(before);
  });

  it("list shows each stored capability with its lifecycle", async () => {
    await writePaymentsAir();
    const io = bufferIO();
    expect(await runAnvilCli(["capability", "list", dir], { io })).toBe(0);
    expect(io.text()).toContain("payments.refunds");
    expect(io.text()).toContain("payments.customers");
    expect(io.text()).toMatch(/proposed/);
  });

  it("show is a small summary by default; sections appear only on request", async () => {
    await writePaymentsAir();
    const io = bufferIO();
    expect(await runAnvilCli(["capability", "show", dir, "payments.refunds"], { io })).toBe(0);
    expect(io.text()).toContain("lifecycle: proposed");
    expect(io.text()).toContain("budget: ok");
    expect(io.text()).not.toContain("payments.refunds.create"); // detail is opt-in

    const withOps = bufferIO();
    await runAnvilCli(["capability", "show", dir, "payments.refunds", "--operations"], {
      io: withOps,
    });
    expect(withOps.text()).toContain("payments.refunds.create");
    expect(withOps.text()).toMatch(/mutation\/financial/);

    const withAuth = bufferIO();
    await runAnvilCli(["capability", "show", dir, "payments.refunds", "--auth"], { io: withAuth });
    expect(withAuth.text()).toMatch(/oauth2/);

    const asJson = bufferIO();
    await runAnvilCli(["capability", "show", dir, "payments.refunds", "--json"], { io: asJson });
    const parsed = JSON.parse(asJson.stdout.join("\n"));
    expect(parsed.capability.id).toBe("payments.refunds");
    expect(parsed.budget.verdict).toBe("ok");
  });

  it("approve and reject atomically reproject the decision across every AIR surface", async () => {
    await writePaymentsAir();
    const io = bufferIO();
    expect(
      await runAnvilCli(["capability", "approve", dir, "payments.refunds", "--note", "ok"], { io }),
    ).toBe(0);
    const approved = reload().capabilities.find((c) => c.id === "payments.refunds");
    expect(approved?.lifecycle).toBe("approved");
    expect(approved?.reviewNote).toBe("ok");
    for (const rel of ["air.json", "cli/air.json", "mcp/air.json", "runtime/air.json"]) {
      const projected = JSON.parse(readFileSync(join(dir, rel), "utf8")) as AirDocument;
      expect(projected.capabilities.find((c) => c.id === "payments.refunds")?.lifecycle).toBe(
        "approved",
      );
    }

    const io2 = bufferIO();
    expect(
      await runAnvilCli(
        ["capability", "reject", dir, "payments.customers", "--reason", "not a unit"],
        { io: io2 },
      ),
    ).toBe(0);
    const rejected = reload().capabilities.find((c) => c.id === "payments.customers");
    expect(rejected?.lifecycle).toBe("rejected");
    expect(rejected?.reviewNote).toBe("not a unit");
    for (const rel of ["air.json", "cli/air.json", "mcp/air.json", "runtime/air.json"]) {
      const projected = JSON.parse(readFileSync(join(dir, rel), "utf8")) as AirDocument;
      expect(projected.capabilities.find((c) => c.id === "payments.customers")?.lifecycle).toBe(
        "rejected",
      );
    }
  });

  it("diff reports no drift for a fresh compile, and drift after the model moves", async () => {
    const air = await writePaymentsAir();
    const clean = bufferIO();
    expect(await runAnvilCli(["capability", "diff", dir, "payments.refunds"], { io: clean })).toBe(
      0,
    );
    expect(clean.text()).toContain("No drift");

    // Retag the refund operation: discovery now groups it elsewhere.
    const moved = structuredClone(air);
    const refund = moved.operations.find((o) => o.id === "payments.refunds.create");
    if (refund) refund.tags = ["disputes"];
    writeFileSync(join(dir, "air.yaml"), airToYaml(moved), "utf8");
    const drift = bufferIO();
    expect(await runAnvilCli(["capability", "diff", dir, "payments.refunds"], { io: drift })).toBe(
      0,
    );
    expect(drift.text()).toContain("drifted");
    expect(drift.text()).toContain("- operation payments.refunds.create");
  });

  it("diff reports a manifest-authored capability truthfully instead of phantom drift", async () => {
    const air = await compile({
      spec: read("openapi.yaml"),
      manifest: `${read("anvil.yaml")}\ncapabilities:\n  payments.support:\n    operations: [getCustomer, getPayment]\n`,
      serviceId: "payments",
    });
    writeBundle(dir, generateBundle(air));

    const io = bufferIO();
    expect(await runAnvilCli(["capability", "diff", dir, "payments.support"], { io })).toBe(0);
    // The honest report: not expected in discovery, members checked against the
    // document — never "discovery no longer proposes this grouping".
    expect(io.text()).toContain("manifest-authored (not expected in discovery)");
    expect(io.text()).toContain("No drift");
    expect(io.text()).not.toContain("no longer proposes");
  });

  it("blocks approving an over-budget capability without --allow-large", async () => {
    const air = await compile({ spec: specWithOps(21), serviceId: "things" });
    writeBundle(dir, generateBundle(air));
    const id = air.capabilities[0]?.id as string;

    const refused = bufferIO();
    expect(await runAnvilCli(["capability", "approve", dir, id], { io: refused })).toBe(1);
    expect(refused.text()).toContain("capability_tool_budget_exceeded");
    expect(refused.text()).toContain("--allow-large");
    expect(reload().capabilities[0]?.lifecycle).toBe("proposed"); // refusal persisted nothing

    const unaudited = bufferIO();
    expect(
      await runAnvilCli(["capability", "approve", dir, id, "--allow-large"], {
        io: unaudited,
      }),
    ).toBe(1);
    expect(unaudited.text()).toContain("capability_budget_waiver_note_required");

    const allowed = bufferIO();
    expect(
      await runAnvilCli(
        [
          "capability",
          "approve",
          dir,
          id,
          "--allow-large",
          "--note",
          "Reviewed as one deliberately large disclosure unit.",
        ],
        { io: allowed },
      ),
    ).toBe(0);
    expect(reload().capabilities[0]?.lifecycle).toBe("approved");
    expect(reload().diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "capability_tool_budget_waived",
          capabilityId: id,
        }),
      ]),
    );
  });

  it("warns (without blocking) between 16 and 20 tools", async () => {
    const air = await compile({ spec: specWithOps(16), serviceId: "things" });
    writeBundle(dir, generateBundle(air));
    const id = air.capabilities[0]?.id as string;
    const io = bufferIO();
    expect(await runAnvilCli(["capability", "approve", dir, id], { io })).toBe(0);
    expect(io.text()).toContain("capability_tool_budget");
    expect(reload().capabilities[0]?.lifecycle).toBe("approved");
  });
});

/**
 * Grounding a grouping in behaviour instead of documentation.
 *
 * The spec-discovery mode above groups by OpenAPI tag — the vendor's reference
 * taxonomy, organised by resource. This mode reads the spool the serving path
 * writes and groups by what was used together inside one `traceId`. The two
 * assertions that matter are that a ubiquitous operation never reaches a member
 * list, and that a grouping is allowed to disagree with the tag taxonomy.
 */
describe("anvil capability propose --from-records", () => {
  /** Drive `count` traces of `operationIds` through the runtime's own spool. */
  function spoolTraces(
    spool: JsonlRecordSpool,
    prefix: string,
    operationIds: string[],
    count: number,
  ): void {
    for (let i = 0; i < count; i++) {
      for (const operationId of operationIds) {
        spool.onRecord({
          traceId: `${prefix}-${i}`,
          operationId,
          effect: "read",
          outcome: "success",
          latencyMs: 3,
          retryCount: 0,
          idempotencyKeyPresent: false,
          requestBytes: 0,
          responseBytes: 32,
          policyDecisions: [],
          confirmationRequired: false,
          confirmed: false,
          principalId: "anonymous",
        });
      }
    }
  }

  it("groups by observed co-occurrence, filtering the operation that is in every trace", async () => {
    const air = await writePaymentsAir();
    const id = (canonical: string) =>
      air.operations.find((op) => op.canonicalName === canonical)?.id as string;
    const customer = id("get_customer");
    const payment = id("get_payment");
    const refund = id("create_refund");
    const capture = id("capture_payment");

    const spoolDir = join(dir, "..", "spool");
    mkdirSync(spoolDir, { recursive: true });
    const spool = new JsonlRecordSpool(spoolDir);
    // Every trace looks the customer up first: the behavioural equivalent of a
    // shared transport envelope, present in every distinct trace shape. The
    // payment read is common too — 3 of the 4 shapes — but not ubiquitous, and
    // the filter has to be selective enough to keep it.
    spoolTraces(spool, "refunding", [customer, payment, refund], 8);
    spoolTraces(spool, "capturing", [customer, payment, capture], 6);
    spoolTraces(spool, "looking-up", [customer, payment], 5);
    spoolTraces(spool, "recapturing", [customer, capture], 5);

    const before = readFileSync(join(dir, "air.yaml"), "utf8");
    const out = join(dir, "..", "observed.report.json");
    const io = bufferIO();
    expect(
      await runAnvilCli(["capability", "propose", dir, "--from-records", spoolDir, "--out", out], {
        io,
      }),
    ).toBe(0);

    // Read-only: the AIR the groupings were derived from is untouched.
    expect(readFileSync(join(dir, "air.yaml"), "utf8")).toBe(before);

    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.reportType).toBe("anvil.observed-capability-proposal");
    expect(report.summary.traces).toBe(24);
    expect(report.summary.traceShapes).toBe(4);

    // The pre-filter fired on the ubiquitous operation, and said so.
    expect(
      report.suppressedUbiquitousOperations.map((s: { operationId: string }) => s.operationId),
    ).toEqual([customer]);
    expect(io.text()).toContain("Filtered before grouping");

    // It is in no grouping and no co-occurrence pair.
    for (const grouping of report.groupings) {
      expect(grouping.operationIds).not.toContain(customer);
    }
    for (const pair of report.cooccurrence) {
      expect([pair.a, pair.b]).not.toContain(customer);
    }

    // Two shapes clear the floor; the third collapses to a single operation.
    expect(report.groupings.map((g: { operationIds: string[] }) => g.operationIds)).toEqual([
      [refund, payment].sort(),
      [capture, payment].sort(),
    ]);
    expect(report.groupings.map((g: { traces: number }) => g.traces)).toEqual([8, 6]);

    // The finding a tag taxonomy cannot make: refunding uses a `refunds`
    // operation and a `payments` operation as one task.
    expect(report.groupings[0].crossesExistingCapabilities).toBe(true);
    expect(report.groupings[0].spansCapabilities).toEqual([
      "payments.payments",
      "payments.refunds",
    ]);
    expect(io.text()).toContain("CUTS ACROSS");

    // Evidence is recorded_traffic, and its provenance is the count.
    const claim = report.groupings[0].evidence[0];
    expect(claim.source).toBe("recorded_traffic");
    expect(claim.note).toContain("8 of 24 recorded trace(s)");

    // Propose-only, stated in the report and on the terminal.
    expect(report.boundary).toMatchObject({
      autoApproved: false,
      writesAir: false,
      buildReady: false,
    });
    expect(io.text()).toContain("Propose-only");
  });

  it("closes the traffic loop: snippet out, manifest in, authored capability approved and built", async () => {
    const air = await writePaymentsAir();
    const id = (canonical: string) =>
      air.operations.find((op) => op.canonicalName === canonical)?.id as string;
    const spoolDir = join(dir, "..", "loop-spool");
    mkdirSync(spoolDir, { recursive: true });
    const spool = new JsonlRecordSpool(spoolDir);
    spoolTraces(spool, "refunding", [id("get_payment"), id("create_refund")], 6);

    // The report carries a ready-to-review authoring snippet per grouping…
    const out = join(dir, "..", "loop-report.json");
    expect(
      await runAnvilCli(["capability", "propose", dir, "--from-records", spoolDir, "--out", out], {
        io: bufferIO(),
      }),
    ).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    const grouping = report.groupings[0];
    expect(grouping.manifestSnippet).toContain("capabilities:");
    expect(grouping.manifestSnippet).toContain("operations:");

    // …and --snippet prints exactly that snippet, alone, for copy-paste.
    const snippetIO = bufferIO();
    expect(
      await runAnvilCli(
        ["capability", "propose", dir, "--from-records", spoolDir, "--snippet", grouping.id],
        { io: snippetIO },
      ),
    ).toBe(0);
    const snippet = snippetIO.text().trimEnd();
    expect(snippet).toBe(grouping.manifestSnippet);

    // Propose-only boundary: nothing wrote the manifest — the OPERATOR pastes
    // the snippet into anvil.yaml and recompiles. Do exactly that.
    const authoredId = `payments.${grouping.id.replace("observed.", "observed_")}`;
    const authoredAir = await compile({
      spec: read("openapi.yaml"),
      manifest: `${read("anvil.yaml")}\n${snippet}\n`,
      serviceId: "payments",
    });
    const loopDir = join(dir, "..", "loop-bundle-src");
    mkdirSync(loopDir, { recursive: true });
    writeBundle(loopDir, generateBundle(authoredAir));
    const authored = authoredAir.capabilities.find((c) => c.id === authoredId);
    expect(authored).toMatchObject({
      source: "manifest",
      lifecycle: "proposed",
      operationIds: grouping.operationIds,
    });

    // Authored ≠ approved: the build gate refuses until the grouping is reviewed.
    const refusedIO = bufferIO();
    expect(await runAnvilCli(["build", loopDir, authoredId], { io: refusedIO })).toBe(1);
    expect(refusedIO.text()).toContain("capability_not_approved");

    expect(
      await runAnvilCli(["capability", "approve", loopDir, authoredId], { io: bufferIO() }),
    ).toBe(0);
    const built = join(loopDir, "authored-bundle");
    expect(
      await runAnvilCli(["build", loopDir, authoredId, "--out", built], { io: bufferIO() }),
    ).toBe(0);

    // The built MCP catalog is exactly the observed members' tools — no more.
    const manifest = JSON.parse(readFileSync(join(built, "bundle.json"), "utf8"));
    const memberTools = grouping.operationIds
      .map(
        (opId: string) =>
          authoredAir.operations.find((op) => op.id === opId)?.mcp.toolName as string,
      )
      .sort();
    expect(manifest.surfaces.mcp.operations).toEqual(memberTools);
    expect(manifest.surfaces.mcp.operations).not.toContain("payments_get_customer");
    expect(manifest.surfaces.mcp.operations).not.toContain("payments_capture_payment");
  });

  it("refuses --snippet without --from-records, and an unknown grouping id, with structured codes", async () => {
    await writePaymentsAir();
    const withoutRecords = bufferIO();
    expect(
      await runAnvilCli(["capability", "propose", dir, "--snippet", "observed.abc"], {
        io: withoutRecords,
      }),
    ).toBe(1);
    expect(withoutRecords.text()).toContain("capability_propose_snippet_without_records");

    const spoolDir = join(dir, "..", "snippet-spool");
    mkdirSync(spoolDir, { recursive: true });
    new JsonlRecordSpool(spoolDir).onRecord({
      traceId: "t-0",
      operationId: "payments.payments.get",
      effect: "read",
      outcome: "success",
      latencyMs: 1,
      retryCount: 0,
      idempotencyKeyPresent: false,
      requestBytes: 0,
      responseBytes: 8,
      policyDecisions: [],
      confirmationRequired: false,
      confirmed: false,
      principalId: "anonymous",
    });
    const unknown = bufferIO();
    expect(
      await runAnvilCli(
        ["capability", "propose", dir, "--from-records", spoolDir, "--snippet", "observed.nope"],
        { io: unknown },
      ),
    ).toBe(1);
    expect(unknown.text()).toContain("capability_propose_snippet_unknown_grouping");
  });

  it("proposes nothing from a spool whose shapes never reach the floor", async () => {
    const air = await writePaymentsAir();
    const ids = air.operations.map((op) => op.id);
    const spoolDir = join(dir, "..", "thin-spool");
    mkdirSync(spoolDir, { recursive: true });
    const spool = new JsonlRecordSpool(spoolDir);
    spoolTraces(spool, "rare", [ids[0] as string, ids[1] as string], 4);

    const io = bufferIO();
    expect(
      await runAnvilCli(["capability", "propose", dir, "--from-records", spoolDir], { io }),
    ).toBe(0);
    expect(io.text()).toContain("No grouping reached 5 trace(s)");
  });
});

describe("anvil build", () => {
  it("builds an approved capability into an aligned bundle with bundle.json", async () => {
    await writePaymentsAir();
    const approve = bufferIO();
    expect(
      await runAnvilCli(["capability", "approve", dir, "payments.payments"], { io: approve }),
    ).toBe(0);

    const out = join(dir, "bundle");
    const io = bufferIO();
    expect(await runAnvilCli(["build", dir, "payments.payments", "--out", out], { io })).toBe(0);
    expect(io.text()).toContain("Built capability payments.payments");
    expect(existsSync(join(out, "bundle.json"))).toBe(true);
    expect(existsSync(join(out, "cli", "payments-payments.mjs"))).toBe(true);
    expect(existsSync(join(out, "mcp", "server.js"))).toBe(true);
    expect(existsSync(join(out, "skill", "SKILL.md"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(out, "bundle.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.capabilityId).toBe("payments.payments");
    expect(manifest.artifactId).toBe("payments-payments");
    expect(manifest.parentServiceId).toBe("payments");
    expect(manifest.surfaces.cli.contractHash).toBe(manifest.contractHash);
    expect(manifest.surfaces.mcp.contractHash).toBe(manifest.contractHash);
    expect(manifest.surfaces.skill.contractHash).toBe(manifest.contractHash);
    // Only this capability's approved operations appear on any surface.
    expect(manifest.surfaces.mcp.operations).toEqual([
      "payments_capture_payment",
      "payments_get_payment",
    ]);
    const skill = readFileSync(join(out, "skill", "SKILL.md"), "utf8");
    expect(skill).toContain("name: payments-payments");
    expect(skill).not.toContain("create_refund");
  });

  it("keeps an authored workflow and reports its cross-capability dependency explicitly", async () => {
    await writePaymentsAir();
    expect(
      await runAnvilCli(["capability", "approve", dir, "payments.refunds"], {
        io: bufferIO(),
      }),
    ).toBe(0);

    const out = join(dir, "refunds-bundle");
    const io = bufferIO();
    expect(await runAnvilCli(["build", dir, "payments.refunds", "--out", out], { io })).toBe(0);
    expect(io.text()).toContain("workflow dependencies: 1");
    const manifest = JSON.parse(readFileSync(join(out, "bundle.json"), "utf8"));
    expect(manifest.artifactId).toBe("payments-refunds");
    expect(manifest.publicOperationIds).toEqual(["payments.refunds.create"]);
    expect(manifest.workflowDependencyOperationIds).toEqual(["payments.payments.get"]);
    expect(readFileSync(join(out, "skill", "SKILL.md"), "utf8")).toContain(
      "name: payments-refunds",
    );
    expect(readFileSync(join(out, "skill", "reference", "workflows.md"), "utf8")).toContain(
      "Refund a customer",
    );
    const packaged = join(dir, "packaged-skills");
    expect(
      await runAnvilCli(["package", "skill", out, "--out", packaged], {
        io: bufferIO(),
      }),
    ).toBe(0);
    expect(existsSync(join(packaged, "payments-refunds", "SKILL.md"))).toBe(true);
  });

  it("refuses to launder an invalid parent gateway receipt during capability build", async () => {
    await writePaymentsAir();
    expect(
      await runAnvilCli(["capability", "approve", dir, "payments.payments"], {
        io: bufferIO(),
      }),
    ).toBe(0);
    writeFileSync(join(dir, "import.receipt.json"), '{"not":"a receipt"}\n', "utf8");

    const io = bufferIO();
    expect(
      await runAnvilCli(
        ["build", dir, "payments.payments", "--out", join(dir, "invalid-lineage")],
        { io },
      ),
    ).toBe(1);
    expect(io.text()).toContain("capability_parent_gateway_receipt_invalid");
    expect(io.text()).toContain("Refusing to drop gateway lineage");
  });

  it("refuses to build gateway-origin AIR when its parent receipt is missing", async () => {
    const air = await compile({
      spec: read("openapi.yaml"),
      manifest: read("anvil.yaml"),
      serviceId: "payments",
    });
    air.service.source.origin = { kind: "kong", uri: "kong://payments" };
    const capability = air.capabilities.find((candidate) => candidate.id === "payments.refunds");
    if (!capability) throw new Error("Expected payments.refunds capability.");
    capability.lifecycle = "approved";
    writeBundle(dir, generateBundle(air));

    const out = join(dir, "missing-lineage");
    const io = bufferIO();
    expect(await runAnvilCli(["build", dir, "payments.refunds", "--out", out], { io })).toBe(1);
    expect(io.text()).toContain("capability_parent_gateway_receipt_missing");
    expect(io.text()).toContain("records gateway origin 'kong'");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses to build a non-approved capability with a structured error", async () => {
    await writePaymentsAir();
    const io = bufferIO();
    expect(await runAnvilCli(["build", dir, "payments.refunds"], { io })).toBe(1);
    expect(io.text()).toContain("capability_not_approved");
    expect(io.text()).toContain("anvil capability approve");
  });

  it("builds nothing from an approved AUTHORED capability whose members are all unapproved", async () => {
    // Authoring grants no approval to members, and approving the GROUPING does
    // not either — the same member gate a discovered capability builds through.
    const air = await compile({
      spec: specWithOps(3),
      serviceId: "things",
      manifest: "capabilities:\n  things.subset:\n    operations: [getThing0, getThing1]\n",
    });
    writeBundle(dir, generateBundle(air));
    expect(
      await runAnvilCli(["capability", "approve", dir, "things.subset"], { io: bufferIO() }),
    ).toBe(0);

    const io = bufferIO();
    expect(await runAnvilCli(["build", dir, "things.subset"], { io })).toBe(1);
    expect(io.text()).toContain("capability_empty");
    expect(io.text()).toContain("anvil approve");
  });

  it("rejects missing arguments with a usage error", async () => {
    const io = bufferIO();
    expect(await runAnvilCli(["build"], { io })).toBe(1);
    expect(io.text()).toContain("missing required argument 'path'");
  });
});
