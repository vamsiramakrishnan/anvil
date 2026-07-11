import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { assembleSystemPack } from "@anvil/system-pack";
import { beforeEach, describe, expect, it } from "vitest";
import { certify, isExpired } from "./certify.js";
import { runMutationBattery } from "./mutate.js";

const SPEC = `openapi: "3.0.3"
info: { title: Refunds, version: "1.0.0" }
paths:
  /refunds:
    get:
      operationId: listRefunds
      tags: [refunds]
      responses: { "200": { description: ok } }
    post:
      operationId: createRefund
      tags: [refunds]
      responses: { "201": { description: created } }
`;

let air: AirDocument;

beforeEach(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "refunds" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
  for (const op of air.operations) {
    op.effect.resource = "refund";
    if (op.sourceRef.operationId === "createRefund") {
      op.auth = { ...op.auth, type: "oauth2_client_credentials", scopes: ["refunds:write"] };
      op.idempotency = { ...op.idempotency, mode: "key_supported" };
    }
  }
});

describe("static vs executable certification", () => {
  it("static-only success is static_passed, never certified", () => {
    const record = certify(air);
    expect(record.status).toBe("static_passed");
    expect(record.checks.every((c) => c.phase === "static")).toBe(true);
  });

  it("executable certification boots the simulator and exercises the surface", () => {
    const record = certify(air, { executable: true });
    const failed = record.checks.filter((c) => !c.ok).map((c) => `${c.id}:${c.detail ?? ""}`);
    expect(failed).toEqual([]);
    expect(record.status).toBe("certified");
    // It actually ran the executable + mutation phases.
    expect(record.checks.some((c) => c.phase === "executable")).toBe(true);
    expect(record.checks.some((c) => c.phase === "mutation")).toBe(true);
  });

  it("binds the attestation to the contract and surface digests", () => {
    const record = certify(air, { executable: true });
    expect(record.attestation.surfaceSignatureDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.attestation.certificationVersion).toBe("0.1.0");
  });
});

describe("the gate kills safety mutants", () => {
  it("every applicable standard mutant is killed", () => {
    const results = runMutationBattery(air);
    const survivors = results.filter((r) => r.applicable && !r.killed);
    expect(survivors).toEqual([]);
    // The safety mutants are detected specifically as safety-sensitive.
    const removeConfirm = results.find((r) => r.name === "remove_confirmation");
    expect(removeConfirm?.classification).toBe("safety-sensitive");
  });

  it("a certification does not survive a removed confirmation", () => {
    const weakened = structuredClone(air);
    const refund = weakened.operations.find((o) => o.sourceRef.operationId === "createRefund");
    if (refund) refund.confirmation.required = false;
    // The prior certification's attestation no longer matches the weakened contract.
    const priorCert = certify(air, { executable: true });
    expect(isExpired(priorCert, weakened)).toBe(true);
  });
});

describe("static pack verification", () => {
  it("fails certification when a packed artifact is tampered", () => {
    const built = assembleSystemPack({
      version: "1.0.0",
      contractRef: { id: "c", digest: "d" },
      artifacts: [
        {
          id: "skill",
          kind: "skill",
          path: "skill/SKILL.md",
          bytes: new TextEncoder().encode("# Refunds\n"),
          build: {
            inputDigests: ["c"],
            implementationVersion: "gen-1",
            configurationDigest: "cfg",
          },
        },
      ],
    });
    const tampered = new Map(built.contents);
    tampered.set("skill/SKILL.md", new TextEncoder().encode("# tampered\n"));
    const record = certify(air, { pack: { pack: built.pack, contents: tampered } });
    expect(record.status).toBe("failed");
    expect(record.checks.find((c) => c.id === "static/pack_verifies")?.ok).toBe(false);
  });
});
