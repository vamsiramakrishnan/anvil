import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, airFromYaml, airToYaml } from "@anvil/air";
import { compile } from "@anvil/compiler";
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
  writeFileSync(join(dir, "air.yaml"), airToYaml(air), "utf8");
  return air;
}

const reload = (): AirDocument => airFromYaml(readFileSync(join(dir, "air.yaml"), "utf8"));

describe("anvil capability", () => {
  it("prints local subcommand usage for a bare `anvil capability`", async () => {
    const io = bufferIO();
    expect(await runAnvilCli(["capability"], { io })).toBe(0);
    expect(io.text()).toContain("Usage: anvil capability");
    expect(io.text()).toMatch(/propose <path>/);
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

  it("approve and reject persist the decision to the AIR file", async () => {
    await writePaymentsAir();
    const io = bufferIO();
    expect(
      await runAnvilCli(["capability", "approve", dir, "payments.refunds", "--note", "ok"], { io }),
    ).toBe(0);
    const approved = reload().capabilities.find((c) => c.id === "payments.refunds");
    expect(approved?.lifecycle).toBe("approved");
    expect(approved?.reviewNote).toBe("ok");

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

  it("blocks approving an over-budget capability without --allow-large", async () => {
    const air = await compile({ spec: specWithOps(21), serviceId: "things" });
    writeFileSync(join(dir, "air.yaml"), airToYaml(air), "utf8");
    const id = air.capabilities[0]?.id as string;

    const refused = bufferIO();
    expect(await runAnvilCli(["capability", "approve", dir, id], { io: refused })).toBe(1);
    expect(refused.text()).toContain("capability_tool_budget_exceeded");
    expect(refused.text()).toContain("--allow-large");
    expect(reload().capabilities[0]?.lifecycle).toBe("proposed"); // refusal persisted nothing

    const allowed = bufferIO();
    expect(
      await runAnvilCli(["capability", "approve", dir, id, "--allow-large"], { io: allowed }),
    ).toBe(0);
    expect(reload().capabilities[0]?.lifecycle).toBe("approved");
  });

  it("warns (without blocking) between 16 and 20 tools", async () => {
    const air = await compile({ spec: specWithOps(16), serviceId: "things" });
    writeFileSync(join(dir, "air.yaml"), airToYaml(air), "utf8");
    const id = air.capabilities[0]?.id as string;
    const io = bufferIO();
    expect(await runAnvilCli(["capability", "approve", dir, id], { io })).toBe(0);
    expect(io.text()).toContain("capability_tool_budget");
    expect(reload().capabilities[0]?.lifecycle).toBe("approved");
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
    expect(existsSync(join(out, "cli", "payments.mjs"))).toBe(true);
    expect(existsSync(join(out, "mcp", "server.js"))).toBe(true);
    expect(existsSync(join(out, "skill", "SKILL.md"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(out, "bundle.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.capabilityId).toBe("payments.payments");
    expect(manifest.surfaces.cli.contractHash).toBe(manifest.contractHash);
    expect(manifest.surfaces.mcp.contractHash).toBe(manifest.contractHash);
    expect(manifest.surfaces.skill.contractHash).toBe(manifest.contractHash);
    // Only this capability's approved operations appear on any surface.
    expect(manifest.surfaces.mcp.operations).toEqual([
      "payments_capture_payment",
      "payments_get_payment",
    ]);
    const skill = readFileSync(join(out, "skill", "SKILL.md"), "utf8");
    expect(skill).not.toContain("create_refund");
  });

  it("refuses to build a non-approved capability with a structured error", async () => {
    await writePaymentsAir();
    const io = bufferIO();
    expect(await runAnvilCli(["build", dir, "payments.refunds"], { io })).toBe(1);
    expect(io.text()).toContain("capability_not_approved");
    expect(io.text()).toContain("anvil capability approve");
  });

  it("rejects missing arguments with a usage error", async () => {
    const io = bufferIO();
    expect(await runAnvilCli(["build"], { io })).toBe(1);
    expect(io.text()).toContain("missing required argument 'path'");
  });
});
