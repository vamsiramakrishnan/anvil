import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { resolveNameCollisions } from "./naming.js";

/**
 * The Stripe refund shape from the public-corpus gauntlet: seven POSTs whose
 * ids all collapsed to `refunds.create.post` + numeric suffixes, because the
 * routes differ only in path parameters and cleanPathTokens strips those. A
 * consuming agent had to open seven schemas to pick one. Collision tokens must
 * be glanceable path semantics, never `post_2`.
 */
function refundOp(n: number, path: string): Operation {
  return OperationSchema.parse({
    id: "stripe.refunds.create",
    canonicalName: "create_refund",
    displayName: `Create refund ${n}`,
    sourceRef: { kind: "openapi", path, method: "post" },
    effect: { kind: "mutation", action: "create", resource: "refund", risk: "financial" },
    input: { params: [] },
    idempotency: { mode: "none" },
    retries: { mode: "none" },
    confirmation: { required: true, risk: "financial" },
    auth: { type: "api_key", scopes: [] },
    cli: { command: "stripe refunds create" },
    mcp: { toolName: "stripe_create_refund" },
    skill: { intentExamples: [] },
    state: "generated",
  });
}

describe("resolveNameCollisions on param-only-distinguished routes", () => {
  it("derives glanceable tokens from path params and structure, never bare method counters", () => {
    const ops = [
      refundOp(1, "/v1/application_fees/{fee}/refunds/{id}"),
      refundOp(2, "/v1/application_fees/{id}/refunds"),
      refundOp(3, "/v1/charges/{charge}/refunds"),
      refundOp(4, "/v1/charges/{charge}/refunds/{refund}"),
      refundOp(5, "/v1/refunds"),
      refundOp(6, "/v1/refunds/{refund}"),
      refundOp(7, "/v1/terminal/refunds"),
    ];
    resolveNameCollisions(ops);

    const ids = ops.map((o) => o.id).sort();
    // Every id is unique and none carries a numeric fallback counter.
    expect(new Set(ids).size).toBe(7);
    for (const id of ids) expect(id).not.toMatch(/_(\d+)$|\.post$/);
    // Param-distinguished routes name their parameter; collection posts say so.
    expect(ids.some((id) => id.endsWith(".by_fee"))).toBe(true);
    expect(ids.some((id) => id.endsWith(".terminal"))).toBe(true);
    expect(ids.some((id) => id.includes("direct"))).toBe(true);
  });
});
