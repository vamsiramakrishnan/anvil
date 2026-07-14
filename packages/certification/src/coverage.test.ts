import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeEach, describe, expect, it } from "vitest";
import { CoverageReport, coverageMatrix } from "./coverage.js";

/**
 * The coverage matrix is generated from the contract and driven through the
 * contract-faithful simulator. These tests pin the enumeration (which
 * dimensions apply to which operations) and the outcomes (every cell holds,
 * because the simulator enforces the same contract the matrix predicts).
 */

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
      // A scoped, confirm-gated, required-idempotency mutation exercises every
      // safety dimension; the list read exercises pagination.
      op.auth = { ...op.auth, type: "oauth2_client_credentials", scopes: ["refunds:write"] };
      op.idempotency = { ...op.idempotency, mode: "required" };
      op.confirmation = { ...op.confirmation, required: true };
    }
    if (op.sourceRef.operationId === "listRefunds") {
      op.effect.action = "list";
    }
  }
});

describe("mechanistic coverage matrix", () => {
  it("enumerates every applicable dimension and every cell holds", () => {
    const report = coverageMatrix(air, { seed: 1 });
    expect(CoverageReport.parse(report)).toEqual(report);
    expect(report.summary.operations).toBe(2);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.passed).toBe(report.summary.cells);
  });

  it("covers auth scope gating on the scoped mutation", () => {
    const report = coverageMatrix(air, { seed: 1 });
    const authCells = report.cells.filter(
      (c) => c.operationId === "refunds.refunds.create" && c.dimension === "auth",
    );
    const variants = authCells.map((c) => c.variant).sort();
    expect(variants).toEqual(["authorized", "missing-scope", "no-principal"]);
    const missing = authCells.find((c) => c.variant === "missing-scope");
    expect(missing?.expected).toBe("permission_denied");
    expect(missing?.ok).toBe(true);
  });

  it("covers the confirmation gate: refusal without confirm, proceed with it", () => {
    const report = coverageMatrix(air, { seed: 1 });
    const gate = report.cells.filter(
      (c) => c.operationId === "refunds.refunds.create" && c.dimension === "confirmation",
    );
    const without = gate.find((c) => c.variant === "without-confirm");
    expect(without?.expected).toBe("confirmation_required");
    expect(without?.actual).toBe("confirmation_required");
  });

  it("covers required idempotency including replay", () => {
    const report = coverageMatrix(air, { seed: 1 });
    const idem = report.cells.filter(
      (c) => c.operationId === "refunds.refunds.create" && c.dimension === "idempotency",
    );
    expect(idem.map((c) => c.variant).sort()).toEqual(["replay", "with-key", "without-key"]);
    expect(idem.find((c) => c.variant === "replay")?.actual).toBe("replayed");
  });

  it("covers pagination on the list read (first page then follow the cursor)", () => {
    const report = coverageMatrix(air, { seed: 1 });
    const pag = report.cells.filter((c) => c.dimension === "pagination");
    expect(pag.map((c) => c.variant).sort()).toEqual(["first-page", "follow-cursor"]);
    expect(pag.every((c) => c.ok)).toBe(true);
  });

  it("covers the fault taxonomy on every operation", () => {
    const report = coverageMatrix(air, { seed: 1 });
    const faultDim = report.dimensions.find((d) => d.dimension === "fault");
    expect(faultDim?.operations).toBe(2);
    // throttle → rate_limited, outage → upstream_unavailable, conflict → conflict.
    const outage = report.cells.find((c) => c.dimension === "fault" && c.variant === "outage");
    expect(outage?.expected).toBe("upstream_unavailable");
    expect(outage?.ok).toBe(true);
  });

  it("is deterministic: same seed and contract enumerate the same cells", () => {
    expect(coverageMatrix(air, { seed: 7 })).toEqual(coverageMatrix(air, { seed: 7 }));
  });
});
