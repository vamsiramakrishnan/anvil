import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { certify } from "@anvil/certification";
import { compile } from "@anvil/compiler";
import {
  certifyBundle,
  generateBundle,
  readBundleDir,
  verifyCertification,
  writeBundle,
} from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundleAir, runCertify } from "./commands/certify.js";
import { bufferIO } from "./io.js";

/**
 * Characterisation, not aspiration.
 *
 * Anvil has two certification implementations. `@anvil/generators/certify.ts`
 * owns the `certification.json` artifact, a four-gate `Certification`
 * (`contract`/`semantic`/`safety`/`runtime`, status `passed|failed|expired`), and
 * `verifyCertification` — the gate `anvil publish` consults. `@anvil/certification`
 * (ADR-0018) owns a different model: a graded `CertificationRecord` with statuses
 * `failed|static_passed|simulator_exercised|certified|expired`, phases
 * `static|executable|mutation`, and an attestation binding.
 *
 * The two meet in exactly one place — `runCertify` in the CLI — which runs both,
 * maps one's checks into the other's shape, and decides how their verdicts
 * combine. That merge rule is domain policy living in a delivery adapter, and the
 * other `certifyBundle` callers do not apply it.
 *
 * These tests pin what is true today so that consolidating the two engines is a
 * change with a visible diff rather than a silent behavioural drift. They assert
 * current behaviour; they do not endorse it. The options and the recommendation
 * are in docs/architecture/certification-authority.md.
 */

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let dir: string;
beforeEach(async () => {
  const air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  dir = mkdtempSync(join(tmpdir(), "anvil-cert-authority-"));
  writeBundle(dir, generateBundle(air));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("certification authority is split across two engines", () => {
  it("`anvil certify` is the only place the two engines are reconciled", () => {
    const io = bufferIO();
    expect(runCertify(dir, {}, io, { now: () => "2026-07-10T00:00:00Z" })).toBe(0);

    const written = JSON.parse(readFileSync(join(dir, "certification.json"), "utf8"));
    // runCertify bridges the canonical engine into the generators-owned record.
    expect(written.assurance?.engine).toBe("@anvil/certification");
    expect(written.assurance?.level).toBe("static");
    expect(written.assurance?.attestation?.contractDigest).toEqual(expect.any(String));

    // Calling the generators engine directly produces no bridge at all.
    const files = readBundleDir(dir);
    const direct = certifyBundle(files, loadBundleAir(dir, files));
    expect(direct.assurance).toBeUndefined();

    // ...and fewer checks, because runCertify appends the canonical engine's
    // checks and the target-kit check on top. Same bundle, two answers about
    // what was verified, depending on which entry point asked.
    expect(written.checks.length).toBeGreaterThan(direct.checks.length);
    const bridged = written.checks.filter((c: { id: string }) =>
      c.id.startsWith("contract.certification-core."),
    );
    expect(bridged.length).toBeGreaterThan(0);
    expect(direct.checks.some((c) => c.id.startsWith("contract.certification-core."))).toBe(false);
  });

  it("the generators record is `passed` while the canonical record is `static_passed`", () => {
    const files = readBundleDir(dir);
    const air = loadBundleAir(dir, files);

    // Two vocabularies for one judgement. Neither is wrong; there are just two.
    expect(certifyBundle(files, air).status).toBe("passed");
    expect(certify(air).status).toBe("static_passed");
  });

  it("the canonical engine's `certified` status is unreachable from any shipped command", () => {
    // ADR-0018: "A pack is `certified` only after its generated surfaces were
    // booted and exercised and every safety mutant was killed." That status is
    // produced solely by certify(air, { executable: true }), and nothing outside
    // the certification package's own tests passes that option. `anvil simulate`
    // reaches the same machinery by calling runMutationBattery and coverageMatrix
    // directly, bypassing the record and its status ladder entirely.
    //
    // This test fails the moment executable certification is wired to a command,
    // which is the point: at that moment the ADR stops being stale and this
    // characterisation should be replaced by a real assertion.
    const callers: string[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        if (/executable:\s*true/.test(readFileSync(full, "utf8"))) {
          callers.push(full.slice(root.length));
        }
      }
    };
    walk(join(root, "packages"));

    expect(
      callers,
      "Executable certification is now reachable from production code. Update ADR-0018 and " +
        "docs/architecture/certification-authority.md, and replace this characterisation.",
    ).toEqual([]);

    // Meanwhile the status is a value the system-pack schema will happily accept,
    // so a pack can declare a certification level the product cannot produce.
    const packModel = readFileSync(join(root, "packages/system-pack/src/model.ts"), "utf8");
    expect(packModel).toContain('"certified"');
  });

  it("publish's gate accepts a record the canonical engine never saw", () => {
    // `assurance` is optional in the Certification schema ("older records omit it
    // and remain readable"), and verifyCertification checks only status and bundle
    // hash. So a record produced straight from the generators engine — no bridge,
    // no canonical checks, no target-kit check — still satisfies the gate that
    // `anvil publish` consults. That is a deliberate compatibility choice; it is
    // pinned here so that tightening it is a decision rather than an accident.
    const files = readBundleDir(dir);
    const bare = certifyBundle(files, loadBundleAir(dir, files));
    expect(bare.status).toBe("passed");
    expect(bare.assurance).toBeUndefined();

    writeFileSync(join(dir, "certification.json"), `${JSON.stringify(bare, null, 2)}\n`, "utf8");
    const verdict = verifyCertification(readBundleDir(dir));
    expect(verdict.ok, "an unbridged record is accepted by the publish gate").toBe(true);
  });
});

describe("certifyBundle call sites do not agree on what certification means", () => {
  /**
   * Each call site is tested against its own expectations elsewhere. Nothing
   * tests that they agree with each other, which is the property that matters:
   * "is this bundle contract-clean?" should not depend on which command asks.
   */
  it("only the certify command applies the bridge and the target-kit check", () => {
    const callers = [
      "packages/cli/src/commands/approve.ts",
      "packages/cli/src/commands/capability/capability-compose.ts",
      "packages/cli/src/commands/idempotency-store.ts",
    ];
    for (const caller of callers) {
      const text = readFileSync(join(root, caller), "utf8");
      expect(text, `${caller} should still call certifyBundle`).toContain("certifyBundle(");
      expect(
        text,
        `${caller} unexpectedly reconciles the canonical engine — if this is intended, the ` +
          `merge rule now has more than one owner and belongs in a single module.`,
      ).not.toContain("@anvil/certification");
    }

    const certifyCommand = readFileSync(join(root, "packages/cli/src/commands/certify.ts"), "utf8");
    expect(certifyCommand).toContain("@anvil/certification");
    expect(certifyCommand).toContain("verifyTargetKit");
  });

  it("every certification.json on disk is written by exactly one code path", () => {
    // If a second writer appears, the artifact's shape stops being owned.
    const writers: string[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const text = readFileSync(full, "utf8");
        if (text.includes("CERTIFICATION_FILE") && /writeFileSync\s*\(/.test(text)) {
          writers.push(full.slice(root.length));
        }
      }
    };
    walk(join(root, "packages"));
    expect(writers).toEqual(["packages/cli/src/commands/certify.ts"]);
  });
});
