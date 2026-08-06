import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-inventory-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

function javaFixture(): string {
  const source = join(work, "refunds-prod");
  mkdirSync(join(source, "refunds", "META-INF"), { recursive: true });
  writeFileSync(
    join(source, "refunds", "META-INF", "ejb-jar.xml"),
    `<ejb-jar><enterprise-beans><session>
      <ejb-name>RefundBean</ejb-name><remote>com.acme.Refunds</remote>
    </session></enterprise-beans></ejb-jar>`,
  );
  writeFileSync(
    join(source, "refunds", "META-INF", "weblogic-ejb-jar.xml"),
    `<weblogic-ejb-jar><weblogic-enterprise-bean>
      <ejb-name>RefundBean</ejb-name><jndi-name>ejb/refunds-v1</jndi-name>
    </weblogic-enterprise-bean></weblogic-ejb-jar>`,
  );
  writeFileSync(
    join(source, "refunds", "META-INF", "weblogic-bindings.xml"),
    `<weblogic-ejb-jar><weblogic-enterprise-bean>
      <ejb-name>RefundBean</ejb-name><jndi-name>ejb/refunds-v2</jndi-name>
    </weblogic-enterprise-bean></weblogic-ejb-jar>`,
  );
  return source;
}

describe("anvil legacy inventory", () => {
  it("emits a complete content-addressed JSON report and writes identical output safely", async () => {
    const source = javaFixture();
    const output = join(work, "reports", "inventory.json");
    const result = await anvil(
      "legacy",
      "inventory",
      source,
      "--environment",
      "prod",
      "--application",
      "refund-service",
      "--out",
      output,
      "--json",
    );

    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.legacy-estate-inventory",
      summary: { artifacts: 3, candidates: 1, conflicts: 1 },
    });
    expect(report.inventory.inventoryId).toMatch(/^li_[a-f0-9]{64}$/);
    expect(report.candidates[0].businessSemantics).toBe("unknown");
    expect(report.candidates[0].conflicts[0].dimension).toBe("binding_target");
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);

    const second = await anvil(
      "legacy",
      "inventory",
      source,
      "--environment",
      "prod",
      "--application",
      "refund-service",
      "--out",
      output,
      "--json",
    );
    expect(second.code).toBe(0);
    expect(second.out).toBe(result.out);
  });

  it("makes conflict gating explicit with --check", async () => {
    const result = await anvil(
      "legacy",
      "inventory",
      javaFixture(),
      "--environment",
      "prod",
      "--application",
      "refund-service",
      "--check",
      "--json",
    );

    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).summary.conflicts).toBe(1);
  });

  it("returns a structured refusal for symlinks and output collisions", async () => {
    const source = javaFixture();
    symlinkSync(join(source, "refunds", "META-INF", "ejb-jar.xml"), join(source, "linked.xml"));
    const linked = await anvil(
      "legacy",
      "inventory",
      source,
      "--environment",
      "prod",
      "--application",
      "refund-service",
      "--json",
    );
    expect(linked.code).toBe(1);
    expect(JSON.parse(linked.out)).toMatchObject({
      reportType: "anvil.legacy-estate-inventory-error",
      code: "legacy/source_symlink_refused",
    });

    rmSync(join(source, "linked.xml"));
    const output = join(work, "existing.json");
    writeFileSync(output, "different\n");
    const collision = await anvil(
      "legacy",
      "inventory",
      source,
      "--environment",
      "prod",
      "--application",
      "refund-service",
      "--out",
      output,
      "--json",
    );
    expect(collision.code).toBe(1);
    expect(JSON.parse(collision.out)).toMatchObject({ code: "legacy/output_exists" });
    expect(readFileSync(output, "utf8")).toBe("different\n");
  });

  it("names invalid options, coordinates, and unreadable sources with stable codes", async () => {
    const source = javaFixture();
    const invalidCollector = await anvil(
      "legacy",
      "inventory",
      source,
      "--environment",
      "prod",
      "--application",
      "refund-service",
      "--collector",
      "magic",
      "--json",
    );
    expect(JSON.parse(invalidCollector.out)).toMatchObject({
      code: "legacy/invalid_option",
      message: expect.stringContaining("Use: auto | java-ee | dotnet | messaging"),
    });

    const invalidCoordinate = await anvil(
      "legacy",
      "inventory",
      source,
      "--environment",
      "production east",
      "--application",
      "refund-service",
      "--json",
    );
    expect(JSON.parse(invalidCoordinate.out)).toMatchObject({
      code: "legacy/invalid_coordinate",
      message: expect.stringContaining("spaces are not allowed"),
    });

    const unreadable = await anvil(
      "legacy",
      "inventory",
      join(work, "absent"),
      "--environment",
      "prod",
      "--application",
      "refund-service",
      "--json",
    );
    expect(JSON.parse(unreadable.out)).toMatchObject({ code: "legacy/source_unreadable" });
  });
});
