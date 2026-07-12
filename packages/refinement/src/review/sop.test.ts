import { describe, expect, it } from "vitest";
import { DEFICIENCY_CATALOG, SEVERITIES } from "../deficiency.js";
import { generateReviewSop } from "./sop.js";

/**
 * Golden guard for the SOP: the review's quality lives in these instructions,
 * so the load-bearing sections — the evidence rule, the output contract, the
 * severity rubric, the per-artifact checklists, and the code mapping — must
 * never be gutted silently.
 */
describe("generateReviewSop", () => {
  const sop = generateReviewSop();

  it("emits the full progressive-disclosure package", () => {
    expect(Object.keys(sop).sort()).toEqual([
      "SKILL.md",
      "reference/cli-surface.md",
      "reference/cross-surface.md",
      "reference/mcp-surface.md",
      "reference/output-contract.md",
      "reference/severity-and-codes.md",
      "reference/skill-surface.md",
    ]);
  });

  it("states the evidence rule as the one invariant", () => {
    const skill = sop["SKILL.md"] ?? "";
    expect(skill).toContain("no evidence, no finding");
    expect(skill).toContain("verbatim");
    expect(skill).toContain("discarded");
    // Restraint is part of the calibration, not an afterthought.
    expect(skill).toContain("Restraint");
    expect(skill).toContain("prefer\nno finding");
  });

  it("specializes per artifact class, teaching the safety posture checks", () => {
    expect(sop["reference/mcp-surface.md"]).toContain("Effect truthfulness");
    expect(sop["reference/mcp-surface.md"]).toContain("safety suffixes");
    expect(sop["reference/cli-surface.md"]).toContain("--confirm");
    expect(sop["reference/cli-surface.md"]).toContain("--idempotency-key");
    expect(sop["reference/cli-surface.md"]).toContain("--dry-run");
    expect(sop["reference/skill-surface.md"]).toContain("only approved operations are exposed");
    expect(sop["reference/skill-surface.md"]).toContain("NEVER retried automatically");
    expect(sop["reference/skill-surface.md"]).toContain("phantom");
    expect(sop["reference/cross-surface.md"]).toContain("agree");
  });

  it("carries the severity rubric and every catalog code (generated, not curated)", () => {
    const ref = sop["reference/severity-and-codes.md"] ?? "";
    for (const s of SEVERITIES) expect(ref).toContain(`**${s}**`);
    for (const code of Object.keys(DEFICIENCY_CATALOG)) expect(ref).toContain(`\`${code}\``);
    expect(ref).toContain("do NOT invent a code");
  });

  it("pins the output contract and calibration examples", () => {
    const contract = sop["reference/output-contract.md"] ?? "";
    expect(contract).toContain("output/review.json");
    expect(contract).toContain('"findings"');
    expect(contract).toContain('"evidence"');
    expect(contract).toContain("VERBATIM");
    // Worked findings for the flaw classes the review exists to catch, plus restraint.
    expect(contract).toContain("flawed mutation description");
    expect(contract).toContain("phantom operation");
    expect(contract).toContain("missing confirm");
    expect(contract).toContain("Non-finding (restraint)");
  });
});
