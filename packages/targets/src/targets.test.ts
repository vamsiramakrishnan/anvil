import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeEach, describe, expect, it } from "vitest";
import { GEMINI_ENTERPRISE_PROFILE } from "./gemini-enterprise.js";
import { generateTargetKit } from "./generate.js";
import { validateTarget } from "./validate.js";

const SPEC = `openapi: "3.0.3"
info: { title: Refunds, version: "1.0.0" }
paths:
  /refunds:
    get:
      operationId: listRefunds
      tags: [refunds]
      description: List refunds.
      responses: { "200": { description: ok } }
    post:
      operationId: createRefund
      tags: [refunds]
      description: Issue a refund.
      responses: { "201": { description: created } }
`;

let air: AirDocument;

beforeEach(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "refunds" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
});

describe("target kit generation", () => {
  it("emits the full Gemini Enterprise kit deterministically", () => {
    const a = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, {
      endpoint: "https://x.example/mcp",
    });
    const b = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, {
      endpoint: "https://x.example/mcp",
    });
    const names = a.files.map((f) => f.path.split("/").pop());
    expect(names).toEqual([
      "action-selection.json",
      "admin-runbook.md",
      "compatibility-report.json",
      "oauth.template.json",
      "organization-policy-checklist.md",
      "server-description.md",
      "setup.json",
      "target-profile.json",
    ]);
    // Deterministic bytes.
    for (let i = 0; i < a.files.length; i++) {
      expect(Buffer.from(a.files[i]!.bytes).equals(Buffer.from(b.files[i]!.bytes))).toBe(true);
    }
  });

  it("lists every approved action for selection", () => {
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE);
    const file = kit.files.find((f) => f.path.endsWith("action-selection.json"));
    const parsed = JSON.parse(new TextDecoder().decode(file!.bytes)) as {
      actions: { name: string }[];
    };
    expect(parsed.actions.map((a) => a.name).sort()).toEqual([
      "refunds_create_refund",
      "refunds_list_refunds",
    ]);
  });
});

describe("target validation", () => {
  it("passes a well-formed contract on an HTTPS endpoint", () => {
    const result = validateTarget(air, GEMINI_ENTERPRISE_PROFILE, {
      endpoint: "https://x.example/mcp",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-HTTPS endpoint", () => {
    const result = validateTarget(air, GEMINI_ENTERPRISE_PROFILE, {
      endpoint: "http://x.example/mcp",
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("target/insecure_transport");
  });

  it("rejects an irreversible mutation that does not confirm (platform won't confirm for you)", () => {
    const weakened = structuredClone(air);
    const refund = weakened.operations.find((o) => o.sourceRef.operationId === "createRefund");
    if (refund) {
      refund.effect.reversible = false;
      refund.confirmation.required = false;
    }
    const result = validateTarget(weakened, GEMINI_ENTERPRISE_PROFILE);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("target/unconfirmed_irreversible_action");
  });

  it("rejects a surface over the action budget", () => {
    const profile = {
      ...GEMINI_ENTERPRISE_PROFILE,
      actionLimits: { maxActions: 1, requiresActionDescriptions: true },
    };
    const result = validateTarget(air, profile);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("target/action_budget_exceeded");
  });

  it("keeps platform requirements out of AIR — the profile is versioned data", () => {
    expect(GEMINI_ENTERPRISE_PROFILE.version).toMatch(/^\d{4}\./);
    expect(GEMINI_ENTERPRISE_PROFILE.unsupportedAssumptions.length).toBeGreaterThan(0);
  });
});
