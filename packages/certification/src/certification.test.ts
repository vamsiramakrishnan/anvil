import type { AirDocument } from "@anvil/air";
import type { ContractSnapshot } from "@anvil/compiler";
import { approveOperations, compile } from "@anvil/compiler";
import { assembleSystemPack } from "@anvil/system-pack";
import { beforeEach, describe, expect, it } from "vitest";
import { certify, certifyContract, isExpired } from "./certify.js";
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
      op.idempotency = {
        mode: "key_supported",
        mechanism: "header",
        key: "Idempotency-Key",
        keyDerivation: "request_fingerprint",
      };
    }
  }
});

describe("static vs executable certification", () => {
  it("fails closed when an approved keyed operation has no injectable carrier", () => {
    const invalid = structuredClone(air);
    const refund = invalid.operations.find((op) => op.sourceRef.operationId === "createRefund");
    if (!refund) throw new Error("fixture operation missing");
    refund.idempotency = {
      mode: "required",
      mechanism: "query",
      key: "invented_key",
      keyDerivation: "client_supplied",
    };
    const record = certify(invalid);
    expect(record.status).toBe("failed");
    expect(
      record.checks.find((entry) => entry.id === "static/idempotency_carriers_supported"),
    ).toMatchObject({ ok: false });
  });

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

describe("review fixes — honest grading and complete expiry", () => {
  it("a surface with no safety-sensitive controls is simulator_exercised, not certified (#20)", async () => {
    // A read-only service: nothing to confirm, no scopes, no non-idempotent
    // mutation — no safety mutant is applicable, so the battery proves nothing.
    const roSpec = `openapi: "3.0.3"
info: { title: Catalog, version: "1.0.0" }
paths:
  /items:
    get:
      operationId: listItems
      tags: [catalog]
      responses: { "200": { description: ok } }
`;
    const compiled = await compile({ spec: roSpec, serviceId: "catalog" });
    const ro = approveOperations(
      compiled,
      compiled.operations.map((o) => o.id),
    );
    const record = certify(ro, { executable: true });
    expect(record.checks.filter((c) => !c.ok)).toEqual([]);
    expect(record.status).toBe("simulator_exercised");
  });

  it("expires when the pack digest changes even if the contract is unchanged (#23)", () => {
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
    const prior = certify(air, { pack: { pack: built.pack, contents: built.contents } });
    // Same contract, but re-certified against a different pack digest → expired.
    const other = assembleSystemPack({
      version: "2.0.0",
      contractRef: { id: "c", digest: "d" },
      artifacts: [
        {
          id: "skill",
          kind: "skill",
          path: "skill/SKILL.md",
          bytes: new TextEncoder().encode("# Refunds v2\n"),
          build: {
            inputDigests: ["c"],
            implementationVersion: "gen-1",
            configurationDigest: "cfg",
          },
        },
      ],
    });
    expect(isExpired(prior, air, { pack: { pack: other.pack, contents: other.contents } })).toBe(
      true,
    );
    // Unchanged contract + same pack → still valid.
    expect(isExpired(prior, air, { pack: { pack: built.pack, contents: built.contents } })).toBe(
      false,
    );
  });
});

describe("certifyContract — only resolved contracts are certifiable (#4)", () => {
  it("refuses a conflicted contract, failing closed", () => {
    const conflicted = {
      status: "conflicted",
      air,
      blockedOperationIds: ["refunds.create_refund"],
    } as unknown as ContractSnapshot;
    const record = certifyContract(conflicted, { executable: true });
    expect(record.status).toBe("failed");
    expect(record.checks.map((c) => c.id)).toContain("static/contract_resolved");
  });

  it("certifies a resolved contract by delegating to certify", () => {
    const resolved = {
      status: "resolved",
      air,
      blockedOperationIds: [],
    } as unknown as ContractSnapshot;
    const viaContract = certifyContract(resolved, { executable: true });
    const viaAir = certify(air, { executable: true });
    expect(viaContract.status).toBe("certified");
    expect(viaContract.digest).toBe(viaAir.digest);
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
