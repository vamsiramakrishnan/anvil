import { describe, expect, it } from "vitest";
import { type Driver, type Property, processAgent, runProcess, runSkillTask } from "./index.js";

const task = {
  task: "Read the object",
  skill: "Use read to retrieve the object",
  catalog: [{ operation: "read", description: "Read an object" }],
};
const driver: Driver = {
  id: "fixture",
  async open() {
    return {
      async invoke() {
        return { status: "ok", value: { id: "p1" } };
      },
      async close() {},
    };
  },
};
const goal: Property = (_scenario, traces) => [
  {
    id: "goal",
    status:
      traces[0]?.events[0]?.outcome.value &&
      (traces[0].events[0].outcome.value as { id: string }).id === "p1"
        ? "passed"
        : "failed",
    detail: "The fixture must return p1",
  },
];

describe("skill execution host", () => {
  it("runs an actual process bridge and captures host-observed tool results", async () => {
    const script = `
      const rl = require('node:readline').createInterface({input:process.stdin});
      let turn = 0;
      rl.on('line', line => {
        const message = JSON.parse(line);
        if (turn++ === 0) {
          if (!message.skill || message.protocol !== 'anvil-fuzz-agent/v1') process.exit(2);
          process.stdout.write(JSON.stringify({id:'1', method:'invoke', operation:'read', input:{}})+'\\n');
        } else {
          if (message.outcome.value.id !== 'p1') process.exit(3);
          process.stdout.write(JSON.stringify({method:'complete'})+'\\n');
        }
      });`;
    const report = await runSkillTask({
      task,
      driver,
      properties: [goal],
      agent: processAgent(
        { command: process.execPath, args: ["-e", script] },
        { harness: "scripted-protocol-test" },
      ),
    });
    expect(report.status).toBe("passed");
    expect(report.traces[0]?.events).toHaveLength(1);
    expect(report.skillDigest).toHaveLength(64);
    expect(report.taskDigest).toHaveLength(64);
    expect(report.agent.metadata.harness).toBe("scripted-protocol-test");
  });

  it("does not accept a completion message as evidence of task success", async () => {
    const report = await runSkillTask({
      task,
      driver,
      properties: [],
      agent: { id: "empty", metadata: {}, async execute() {} },
    });
    expect(report.status).toBe("inconclusive");
    expect(report.replay).toBeUndefined();
  });

  it("bounds invocations and rejects undeclared tools", async () => {
    for (const operation of ["read", "unlisted"]) {
      const report = await runSkillTask({
        task,
        driver,
        maxCalls: 1,
        properties: [goal],
        agent: {
          id: "over-budget",
          metadata: {},
          async execute(_task, invoke) {
            await invoke(operation, {});
            await invoke(operation, {});
          },
        },
      });
      expect(report.status).toBe(operation === "read" ? "inconclusive" : "failed");
      expect(report.traces[0]?.events.length).toBeLessThanOrEqual(1);
      expect(report.checks.some((c) => c.id === "agent.execution")).toBe(true);
    }
  });

  it("kills a stalled harness and closes the fixture", async () => {
    let closed = false;
    const observed: Driver = {
      ...driver,
      async open(context) {
        const session = await driver.open(context);
        return {
          ...session,
          async close() {
            closed = true;
          },
        };
      },
    };
    const report = await runSkillTask({
      task,
      driver: observed,
      properties: [],
      timeoutMs: 150,
      agent: processAgent({
        command: process.execPath,
        args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
      }),
    });
    expect(report.status).toBe("inconclusive");
    expect(closed).toBe(true);
  });

  it("treats duplicate request ids as a protocol failure", async () => {
    const script = `process.stdin.once('data',()=>{for(let i=0;i<2;i++) process.stdout.write(JSON.stringify({id:'same',method:'invoke',operation:'read',input:{}})+'\\n');});`;
    const report = await runSkillTask({
      task,
      driver,
      properties: [goal],
      timeoutMs: 2000,
      agent: processAgent({ command: process.execPath, args: ["-e", script] }),
    });
    expect(report.status).toBe("inconclusive");
    expect(report.traces[0]?.events).toHaveLength(1);
  });

  it("rejects oversized process output instead of parsing a truncated result", async () => {
    await expect(
      runProcess(
        { command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(10000))"] },
        "",
        new AbortController().signal,
        100,
      ),
    ).rejects.toThrow("output limit");
  });
});
