import { type AirDocument, hashCanonical, operationInputSchema } from "@anvil/air";
import { beforeAll, describe, expect, it } from "vitest";
import { approveOperations, compile } from "../compile.js";
import { capabilityContractFor, capabilityContractsFor } from "./contract.js";
import { disclosurePlanFor } from "./disclosure.js";
import { editCapabilityContract, moveOperation } from "./edit.js";
import {
  diffSurfaceSignature,
  surfaceSignatureFor,
  surfaceSignatureForContract,
} from "./signature.js";

const SPEC = `openapi: "3.0.3"
info: { title: Payments, version: "3.2.0" }
paths:
  /items:
    get:
      operationId: listItems
      tags: [catalog]
      responses: { "200": { description: ok } }
  /payments/{id}/refunds:
    post:
      operationId: refundPayment
      tags: [refunds]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "201": { description: created } }
`;

let air: AirDocument;
let idByOp: Record<string, string>;

beforeAll(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "payments" });
  const ids = compiled.operations.map((o) => o.id);
  air = approveOperations(compiled, ids);
  idByOp = Object.fromEntries(air.operations.map((o) => [o.sourceRef.operationId as string, o.id]));
});

describe("capability contracts", () => {
  it("derives one contract per discovered capability from approved members", () => {
    const contracts = capabilityContractsFor(air);
    expect(contracts.length).toBe(air.capabilities.length);
    for (const c of contracts) {
      expect(c.operationIds.length).toBeGreaterThan(0);
      expect(c.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("aggregates a safety profile that flags the non-idempotent financial mutation", () => {
    const refundsCap = air.capabilities.find((c) => c.operationIds.includes(idByOp.refundPayment));
    const contract = capabilityContractFor(air, refundsCap?.id as string);
    expect(contract.safetyProfile.confirmationRequiredOps).toContain(idByOp.refundPayment);
    expect(contract.safetyProfile.nonIdempotentMutationOps).toContain(idByOp.refundPayment);
    expect(contract.safetyProfile.highestRisk).toBe("financial");
  });
});

describe("disclosure plan is the single owner", () => {
  it("opens with the capability overview and one node set per member op", () => {
    const cap = air.capabilities[0];
    const plan = disclosurePlanFor(air, cap?.id as string);
    expect(plan.summary[0]?.kind).toBe("overview");
    for (const opId of cap?.operationIds ?? []) {
      expect(plan.operations[opId]?.some((n) => n.kind === "operation")).toBe(true);
    }
  });
});

describe("surface signature — the shared fingerprint", () => {
  it("is deterministic and matches the MCP tool name + shared input schema", () => {
    const a = surfaceSignatureFor(air);
    const b = surfaceSignatureFor(air);
    expect(a.digest).toBe(b.digest);
    for (const sig of a.operations) {
      const op = air.operations.find((o) => o.id === sig.id);
      expect(sig.publicName).toBe(op?.mcp.toolName); // MCP parity
      expect(sig.inputSchemaDigest).toBe(hashCanonical(operationInputSchema(op!))); // CLI/skill parity
    }
  });

  it("only approved operations enter the signature", () => {
    const withUnapproved = structuredClone(air);
    const target = withUnapproved.operations.find((o) => o.id === idByOp.listItems);
    if (target) target.state = "review_required";
    const sig = surfaceSignatureFor(withUnapproved);
    expect(sig.operations.some((o) => o.id === idByOp.listItems)).toBe(false);
  });
});

describe("compatibility classification", () => {
  it("classifies identical / additive / breaking / safety-sensitive", () => {
    const base = surfaceSignatureFor(air);
    expect(diffSurfaceSignature(base, base).classification).toBe("compatible");

    // Removed op → breaking.
    const removed = { ...base, operations: base.operations.slice(1) };
    expect(diffSurfaceSignature(base, removed).classification).toBe("breaking");
    // Added op (base has fewer) → additive.
    expect(diffSurfaceSignature(removed, base).classification).toBe("additive");

    // Auth change → safety-sensitive.
    const authChanged = structuredClone(air);
    const op = authChanged.operations.find((o) => o.id === idByOp.refundPayment);
    if (op) op.auth = { ...op.auth, scopes: ["refunds:write"] };
    const report = diffSurfaceSignature(base, surfaceSignatureFor(authChanged));
    expect(report.classification).toBe("safety-sensitive");
    expect(report.changes.find((c) => c.operationId === idByOp.refundPayment)?.fields).toContain(
      "auth",
    );
  });
});

describe("declarative capability editing", () => {
  it("moves one operation between capabilities without touching AIR", () => {
    const contracts = capabilityContractsFor(air);
    const [a, b] = contracts;
    if (!a || !b) throw new Error("need two capabilities");
    const movedOp = a.operationIds[0] as string;

    const result = moveOperation(air, a, b, movedOp);
    expect(result.from.operationIds).not.toContain(movedOp);
    expect(result.to.operationIds).toContain(movedOp);
    // AIR is untouched; digests recompute from the new membership.
    expect(result.from.digest).not.toBe(a.digest);
    expect(result.to.digest).not.toBe(b.digest);
    expect(air.capabilities.find((c) => c.id === a.id)?.operationIds).toContain(movedOp);
  });

  it("supports declarative intent/owner edits", () => {
    const [c] = capabilityContractsFor(air);
    if (!c) throw new Error("need a capability");
    const edited = editCapabilityContract(air, c, {
      intents: ["issue a refund"],
      counterIntents: ["cancel a subscription"],
      owner: { id: "payments-team", kind: "team" },
    });
    expect(edited.intents).toEqual(["issue a refund"]);
    expect(edited.counterIntents).toEqual(["cancel a subscription"]);
    expect(edited.owner?.id).toBe("payments-team");
  });
});

describe("review fixes — capability contract integrity", () => {
  it("a moved-in operation appears in disclosure and the contract signature (#7/#8)", () => {
    const contracts = capabilityContractsFor(air);
    const [a, b] = contracts;
    if (!a || !b) throw new Error("need two capabilities");
    const movedOp = a.operationIds[0] as string;
    const { to } = moveOperation(air, a, b, movedOp);

    // #7: disclosure keys exactly match membership — the moved op is disclosed.
    expect(Object.keys(to.disclosure.operations).sort()).toEqual([...to.operationIds].sort());
    expect(to.disclosure.operations[movedOp]?.some((n) => n.kind === "operation")).toBe(true);

    // #8: the signature derived from the contract includes the moved op, even
    // though air.capabilities still groups it elsewhere.
    const sig = surfaceSignatureForContract(air, to);
    expect(sig.operations.some((o) => o.id === movedOp)).toBe(true);
  });

  it("a safety-profile override changes the digest (#6)", () => {
    const [c] = capabilityContractsFor(air);
    if (!c) throw new Error("need a capability");
    const edited = editCapabilityContract(air, c, {
      safetyProfile: { highestRisk: "destructive" },
    });
    expect(edited.safetyProfile.highestRisk).toBe("destructive");
    expect(edited.digest).not.toBe(c.digest); // digest tracks the override
  });
});
