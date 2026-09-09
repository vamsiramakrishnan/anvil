import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleHash, readBundleDir } from "@anvil/generators";
import { compilePaymentFuzzFixture } from "@anvil/harness";
import { buildRefinementPlan, caseService } from "@anvil/refinement";
import { afterEach, describe, expect, it } from "vitest";
import { runFuzzCommand } from "./commands/fuzz.js";
import { bufferIO } from "./io.js";

const roots: string[] = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), "anvil-cmd-fuzz-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("anvil fuzz", () => {
  it("freezes report bytes through the existing case evidence policy", async () => {
    const out = root();
    const air = await compilePaymentFuzzFixture();
    const deficiency = buildRefinementPlan(air).deficiencies.find(
      (d) => d.code === "missing_field_description",
    );
    if (!deficiency) throw new Error("The owned fixture must have a field to investigate");
    const caseRun = caseService.open(air, deficiency, {
      root: join(out, "cases"),
      repositoryRoot: out,
    });
    const options = {
      example: "payments",
      surfaces: "python",
      runs: 1,
      out,
      json: true,
      case: caseRun.dir,
      predicate: "field.usage",
      value: '"Observed in the owned payment fixture"',
    };
    expect(await runFuzzCommand(undefined, options, bufferIO())).toBe(0);
    const evidence = JSON.parse(readFileSync(join(caseRun.dir, "output/evidence.json"), "utf8"));
    expect(evidence.artifacts[0].source).toBe("test_fixture");
    expect(evidence.artifacts[0].verification.status).toBe("verified");
    expect(JSON.parse(evidence.artifacts[0].excerpt).identity.fixture).toBe("payments/v1");
    await expect(
      runFuzzCommand(
        undefined,
        { ...options, predicate: "operation.idempotency_mode" },
        bufferIO(),
      ),
    ).rejects.toThrow("not permitted");
    expect(
      JSON.parse(readFileSync(join(caseRun.dir, "output/evidence.json"), "utf8")).artifacts,
    ).toHaveLength(1);
  });
  it("writes hash-bound evidence and refuses a stale replay unless the repair is acknowledged", async () => {
    const out = root();
    const initial = bufferIO();
    expect(
      await runFuzzCommand(
        undefined,
        { example: "payments", surfaces: "python", runs: 1, seed: 39, out, json: true },
        initial,
      ),
    ).toBe(0);
    const first = JSON.parse(initial.text());
    expect(first.identity.bundle).toBe(bundleHash(readBundleDir(first.artifacts.bundle)));
    expect(statSync(first.artifacts.report).mode & 0o777).toBe(0o600);
    const client = join(first.artifacts.bundle, "sdk/python/anvil_fuzz_payments/client.py");
    const original = readFileSync(client, "utf8");
    writeFileSync(
      client,
      original.replace(
        "idempotency_key=idempotency_key,",
        "idempotency_key=__import__('uuid').uuid4().hex if idempotency_key else None,",
      ),
    );
    const failing = bufferIO();
    expect(
      await runFuzzCommand(
        first.artifacts.bundle,
        { fixture: "payments", surfaces: "python", runs: 1, seed: 39, out, json: true },
        failing,
      ),
    ).toBe(1);
    const failure = JSON.parse(failing.text());
    expect(failure.replay.scenario.steps).toHaveLength(3);
    writeFileSync(client, original);
    const options = {
      fixture: "payments",
      surfaces: "python",
      replay: failure.artifacts.replay,
      out,
      json: true,
    };
    await expect(runFuzzCommand(first.artifacts.bundle, options, bufferIO())).rejects.toThrow(
      "identity mismatch",
    );
    const repaired = bufferIO();
    expect(
      await runFuzzCommand(first.artifacts.bundle, { ...options, againstCurrent: true }, repaired),
    ).toBe(0);
    expect(JSON.parse(repaired.text()).identityChanges.bundle).toEqual({
      recorded: failure.identity.bundle,
      current: first.identity.bundle,
    });
  });

  it("executes a scripted skill bridge through CLI→MCP and keeps its task oracle on replay", async () => {
    const out = root();
    const config = join(out, "agent.json");
    const script = `const rl=require('node:readline').createInterface({input:process.stdin});let turn=0;rl.on('line',line=>{const msg=JSON.parse(line);if(turn++===0){const op=msg.catalog.find(o=>o.operation.endsWith('.payments.get'));process.stdout.write(JSON.stringify({id:'read',method:'invoke',operation:op.operation,input:{payment_id:'p1'}})+'\\n');}else{process.stdout.write(JSON.stringify({method:'complete'})+'\\n');}});`;
    writeFileSync(
      config,
      JSON.stringify({
        command: process.execPath,
        args: ["-e", script],
        metadata: { harness: "scripted-protocol-test" },
      }),
    );
    const io = bufferIO();
    expect(
      await runFuzzCommand(
        undefined,
        { example: "payments", surfaces: "cli-mcp", agentConfig: config, out, json: true },
        io,
      ),
    ).toBe(1);
    const report = JSON.parse(io.text());
    expect(report.checks.find((c: { id: string }) => c.id === "payment.task-goal").status).toBe(
      "failed",
    );
    expect(report.agent.metadata.harness).toBe("scripted-protocol-test");
    expect(report.traces[0].events[0].outcome.value.id).toBe("p1");
    const replayed = bufferIO();
    expect(
      await runFuzzCommand(
        report.artifacts.bundle,
        {
          fixture: "payments",
          surfaces: "cli-mcp",
          replay: report.artifacts.replay,
          out,
          json: true,
        },
        replayed,
      ),
    ).toBe(1);
    expect(
      JSON.parse(replayed.text()).diagnostic.checks.some(
        (c: { id: string; status: string }) =>
          c.id === "payment.task-goal" && c.status === "failed",
      ),
    ).toBe(true);
  });

  it("rejects ambiguous targets and invalid budgets before execution", async () => {
    await expect(runFuzzCommand("bundle", { example: "payments" }, bufferIO())).rejects.toThrow(
      "Supply a bundle",
    );
    await expect(
      runFuzzCommand(undefined, { example: "payments", runs: 0 }, bufferIO()),
    ).rejects.toThrow("Invalid seed");
    await expect(
      runFuzzCommand(undefined, { example: "payments", surfaces: "mcp,mcp" }, bufferIO()),
    ).rejects.toThrow("distinct");
    await expect(
      runFuzzCommand(undefined, { example: "payments", againstCurrent: true }, bufferIO()),
    ).rejects.toThrow("requires --replay");
  });
});
