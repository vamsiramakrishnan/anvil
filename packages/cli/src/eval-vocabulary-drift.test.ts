import { type AirDocument, EVAL_VOCABULARY, isConceptToken, loadAirDocument } from "@anvil/air";
import { generateEvals } from "@anvil/generators";
import { generateRefinementSkill } from "@anvil/refinement";
import { describe, expect, it } from "vitest";
import { parse as fromYaml } from "yaml";
import { bufferIO } from "./io.js";
import { createAnvilProgram } from "./program.js";
import { generateAnvilSkill } from "./self-skill.js";

/**
 * The smallest estate that makes every bundle suite emit cases: one approved
 * read carrying an intent example (operation_selection), and one approved
 * mutation that requires an idempotency key (idempotency_behavior). The
 * error_recovery suite is static, so it comes along regardless.
 */
function approvedPaymentsAir(): AirDocument {
  const common = {
    retries: { mode: "safe" as const },
    auth: { type: "api_key" as const },
    errors: [],
    evidence: { claims: [] },
    state: "approved" as const,
  };
  return loadAirDocument({
    service: { id: "pay", displayName: "Payments", version: "1", source: { kind: "openapi" } },
    operations: [
      {
        ...common,
        id: "pay.charges.list",
        canonicalName: "list_charges",
        displayName: "List charges",
        description: "List charges.",
        sourceRef: { kind: "openapi", path: "/charges", method: "get" },
        effect: { kind: "read", action: "list", resource: "charge" },
        idempotency: { mode: "natural" },
        confirmation: { required: false },
        input: { params: [] },
        cli: { command: "pay charges list" },
        mcp: { toolName: "pay_list_charges" },
        skill: { intentExamples: ["show me the charges"] },
      },
      {
        ...common,
        id: "pay.refunds.create",
        canonicalName: "create_refund",
        displayName: "Create refund",
        description: "Refund a charge.",
        sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
        effect: {
          kind: "mutation",
          action: "create",
          resource: "refund",
          risk: "high",
          reversible: false,
        },
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "Idempotency-Key",
          keyDerivation: "client_supplied",
        },
        confirmation: { required: true },
        retries: { mode: "none" as const },
        input: { params: [{ name: "charge_id", in: "body", required: true }] },
        cli: { command: "pay refunds create" },
        mcp: { toolName: "pay_create_refund" },
        skill: { intentExamples: ["refund a customer"] },
      },
    ],
  });
}

/**
 * The gate that keeps Anvil's behaviour checks runnable.
 *
 * Three surfaces emit `evals/*.yaml`: the self-skill, the refinement skill, and
 * every generated bundle. Their cases assert behaviour with `must_call` /
 * `must_include` / `must_not` / `must_refuse_without`. Entries come in two
 * kinds — literals, which check themselves (`anvil inspect`, `--confirm`, a
 * value the document supplied), and concept tokens, which name a behaviour and
 * mean nothing without a definition.
 *
 * For most of this repository's life the concept tokens were defined nowhere.
 * That is why no runner was ever written against them: you cannot grade
 * `not_exactly_once` or `authority_from_similarity` without saying what they
 * mean. Sixty undefined tokens shipped inside every customer bundle as
 * behaviour checks nothing could execute.
 *
 * So this test holds the invariant in both directions. Every token an emitter
 * writes must be defined in `EVAL_VOCABULARY`, which stops a new check from
 * shipping as an unrunnable promise; and every definition must be reachable
 * from some emitter, which stops the vocabulary from accumulating entries for
 * checks that no longer exist. The pair is what keeps the glossary honest —
 * the same shape as the self-skill drift guard next door, applied to meaning
 * rather than to bytes.
 */

/** Every entry any emitted suite asserts, with the file it came from. */
function emittedEntries(): Map<string, string[]> {
  const files: Record<string, string> = {};
  const program = createAnvilProgram({ io: bufferIO() });
  for (const [rel, body] of Object.entries(generateAnvilSkill(program))) {
    if (rel.startsWith("evals/") && rel.endsWith(".yaml")) files[`self-skill:${rel}`] = body;
  }
  for (const [rel, body] of Object.entries(generateRefinementSkill())) {
    if (rel.startsWith("evals/") && rel.endsWith(".yaml")) files[`refinement:${rel}`] = body;
  }
  for (const [rel, body] of Object.entries(generateEvals(approvedPaymentsAir()))) {
    if (rel.startsWith("evals/") && rel.endsWith(".yaml")) files[`bundle:${rel}`] = body;
  }

  const seen = new Map<string, string[]>();
  for (const [origin, body] of Object.entries(files)) {
    const doc = fromYaml(body) as { cases?: Array<{ expected?: Record<string, unknown> }> };
    for (const testCase of doc.cases ?? []) {
      for (const list of Object.values(testCase.expected ?? {})) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          if (typeof entry !== "string" || !isConceptToken(entry)) continue;
          seen.set(entry, [...(seen.get(entry) ?? []), origin]);
        }
      }
    }
  }
  return seen;
}

describe("eval vocabulary", () => {
  it("defines every concept token the three emitters write", () => {
    const emitted = emittedEntries();
    // A guard that finds nothing is a guard that has stopped running. These
    // suites are the reason this file exists, so an empty sweep is a failure.
    expect(emitted.size).toBeGreaterThan(0);
    const undefinedTokens = [...emitted.entries()]
      .filter(([token]) => !(token in EVAL_VOCABULARY))
      .map(([token, origins]) => `${token} (from ${[...new Set(origins)].join(", ")})`)
      .sort();
    expect(
      undefinedTokens,
      "These behaviour checks name a token nothing defines, so no runner can grade them. " +
        "Define each in packages/air/src/eval-vocabulary.ts — with signals when wording " +
        "genuinely separates the behaviour, or judgeOnly when it does not.",
    ).toEqual([]);
  });

  it("keeps no definition for a token no emitter writes", () => {
    const emitted = emittedEntries();
    const orphans = Object.keys(EVAL_VOCABULARY)
      .filter((token) => !emitted.has(token))
      .sort();
    expect(
      orphans,
      "These vocabulary entries define checks nothing emits any more. Remove them, or " +
        "restore the case that used them — an unused definition is documentation of a " +
        "promise the product stopped making.",
    ).toEqual([]);
  });

  it("states, for every term, what satisfies it and what violates it", () => {
    // A definition a grader cannot apply is the original defect wearing a
    // glossary. Each term must carry a check plus both concrete directions.
    const thin = Object.entries(EVAL_VOCABULARY)
      .filter(
        ([, term]) => !term.check.trim() || !term.satisfiedBy.trim() || !term.violatedBy.trim(),
      )
      .map(([token]) => token)
      .sort();
    expect(thin, "every term needs check, satisfiedBy and violatedBy").toEqual([]);
  });

  it("never claims a deterministic signal and a judge-only verdict at once", () => {
    // `judgeOnly` is the honest admission that no wording decides the term.
    // Carrying signals alongside it would let the grader score the term one way
    // while the definition says it cannot be scored at all.
    const contradictory = Object.entries(EVAL_VOCABULARY)
      .filter(([, term]) => term.judgeOnly && (term.signals?.length ?? 0) > 0)
      .map(([token]) => token)
      .sort();
    expect(contradictory, "a judgeOnly term must not also carry signals").toEqual([]);
  });

  it("compiles every signal as a regular expression", () => {
    const broken: string[] = [];
    for (const [token, term] of Object.entries(EVAL_VOCABULARY)) {
      for (const pattern of term.signals ?? []) {
        try {
          new RegExp(pattern, "i");
        } catch (error) {
          broken.push(`${token}: /${pattern}/ — ${(error as Error).message}`);
        }
      }
    }
    expect(broken, "a signal that cannot compile silently grades nothing").toEqual([]);
  });
});
