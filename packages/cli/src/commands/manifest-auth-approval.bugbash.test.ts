import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAir } from "@anvil/refinement";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";
import { runApprove } from "./approve.js";

/**
 * Proves the receipt-bound approval gap this change closes end to end: a
 * gateway-imported (`anvil estate import`) bundle with an
 * oauth2_authorization_code operation refuses in-place `anvil approve` by
 * design (packages/generators/src/bundle-reproject.ts's
 * assertImmutableGatewayLineage) — before this change that left the
 * operation with NO approval path at all, because manifest.ts's
 * oauth2_authorization_code branch forced review_required unconditionally
 * regardless of what a supplemental manifest asked for. Now a re-import with
 * `reviewed_by`/`review_reason` alongside `state: approved` is the escape
 * hatch, and it is receipt-bound like every other reviewed decision on this
 * kind of bundle.
 */

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "anvil-auth-approval-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KONG_CONFIG = `_format_version: "3.0"
services:
  - name: refunds
    routes:
      - name: refunds-route
        paths: ["/refunds/{id}/approve"]
        methods: ["POST"]
    plugins:
      - name: openid-connect
        config:
          scopes: ["refunds:approve"]
`;

// An authorization-code security scheme — the spec is the source of the
// declared auth contract; the gateway export above supplies only the route.
const REFUNDS_APPROVE_OPENAPI = `openapi: "3.0.3"
info: { title: Refunds, version: "1.0.0" }
components:
  securitySchemes:
    enterprise_oidc:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://idp.example.test/oauth/authorize
          tokenUrl: https://idp.example.test/oauth/token
          scopes:
            refunds:approve: Approve a refund on the customer's behalf
security:
  - enterprise_oidc: [refunds:approve]
paths:
  /refunds/{id}/approve:
    post:
      operationId: approveRefund
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`;

async function importGatewayBundle(
  root: string,
  out: string,
  manifest?: string,
): Promise<{ bundle: string; code: number; io: ReturnType<typeof bufferIO> }> {
  const gateway = join(root, "kong.yaml");
  const spec = join(root, "refunds.openapi.yaml");
  writeFileSync(gateway, KONG_CONFIG);
  writeFileSync(spec, REFUNDS_APPROVE_OPENAPI);
  const args = [
    "estate",
    "import",
    gateway,
    "--vendor",
    "kong",
    "--spec",
    spec,
    "--gateway-url",
    "https://gateway.example.test",
    "--out",
    out,
    "--root",
    root,
  ];
  if (manifest) {
    const manifestPath = join(root, "review.yaml");
    writeFileSync(manifestPath, manifest);
    args.push("--manifest", manifestPath);
  }
  const io = bufferIO();
  const code = await runAnvilCli(args, { io });
  return { bundle: out, code, io };
}

describe("receipt-bound authorization-code approval", () => {
  it("has no in-place approval path after a plain import, and gains one only via manifest reviewed_by + review_reason on re-import", async () => {
    const root = freshDir();

    // 1) Plain import, no supplemental manifest: end-user authority forces
    //    review_required unconditionally, exactly as an ordinary compile does.
    const first = await importGatewayBundle(root, join(root, "bundle"));
    expect(first.code, first.io.text()).toBe(0);
    const firstAir = loadAir(first.bundle);
    const op = firstAir.operations.find((o) => o.sourceRef.operationId === "approveRefund");
    if (!op) throw new Error("fixture did not compile an approveRefund operation");
    expect(op.auth.type).toBe("oauth2_authorization_code");
    expect(op.state).toBe("review_required");

    // 2) `anvil approve` is refused in place: the receipt binds this bundle,
    //    and mutating it directly would sever the import-to-approval lineage.
    //    This is the actual gap before the fix — there was no other door.
    const approveIo = bufferIO();
    let thrown: Error | undefined;
    try {
      runApprove(first.bundle, [op.id], approveIo);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain(
      "in-place approval would sever its import-to-approval lineage",
    );
    expect(thrown?.message).toContain("anvil estate import");

    // 3) Re-import with a supplemental manifest naming state: approved PLUS
    //    reviewed_by and review_reason: the receipt-bound re-import path this
    //    auth type previously had no way to reach.
    const second = await importGatewayBundle(
      root,
      join(root, "bundle-reviewed"),
      `operations:
  approveRefund:
    state: approved
    reviewed_by: security-review@example.com
    review_reason: >-
      Delegation reviewed against the customer's consent screen; the scope is
      limited to approving refunds the customer already requested.
`,
    );
    expect(second.code, second.io.text()).toBe(0);
    const secondAir = loadAir(second.bundle);
    const reviewedOp = secondAir.operations.find(
      (o) => o.sourceRef.operationId === "approveRefund",
    );
    if (!reviewedOp)
      throw new Error("re-imported fixture did not compile an approveRefund operation");
    expect(reviewedOp.auth.type).toBe("oauth2_authorization_code");
    expect(reviewedOp.state).toBe("approved");
    const notes = reviewedOp.reviewNotes.join(" ");
    expect(notes).toContain("end-user authority granted by manifest");
    expect(notes).toContain("security-review@example.com");
    expect(notes).toContain("consent screen");

    // The re-imported bundle is itself receipt-bound (a fresh import, not a
    // patched copy) — so this reviewed decision is provenance, not an
    // after-the-fact annotation on unreviewed output.
    const receiptPath = join(second.bundle, "import.receipt.json");
    expect(() => readFileSync(receiptPath, "utf8")).not.toThrow();
  });

  it("still refuses an approved manifest state with no reviewer or reason on a receipt-bound import", async () => {
    const root = freshDir();
    const result = await importGatewayBundle(
      root,
      join(root, "bundle"),
      `operations:
  approveRefund:
    state: approved
`,
    );
    expect(result.code, result.io.text()).toBe(0);
    const air = loadAir(result.bundle);
    const op = air.operations.find((o) => o.sourceRef.operationId === "approveRefund");
    if (!op) throw new Error("fixture did not compile an approveRefund operation");
    expect(op.state).toBe("review_required");
    const notes = op.reviewNotes.join(" ");
    expect(notes).toContain("never a material-completeness one");
    expect(notes).toContain("reviewed_by");
    expect(notes).toContain("review_reason");

    // Approval still has no in-place door either.
    const approveIo = bufferIO();
    expect(() => runApprove(result.bundle, [op.id], approveIo)).toThrow(
      /bound to immutable gateway receipt/,
    );
  });
});
