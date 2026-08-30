import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import {
  classifyPathGrammar,
  estateContextEnabled,
  measurePathGrammarEvidence,
  type PathGrammarOperationShape,
} from "./path-grammar.js";

/**
 * The path-grammar classifier: cheap, deterministic estate-wide evidence in,
 * one named verdict out — and an explicit refusal (`ambiguous`) whenever the
 * evidence genuinely splits. Every synthetic estate here is shaped after a
 * measured one (Plaid, Slack, Zendesk, NetSuite's lowered WSDL), so a drifted
 * threshold fails on the grammar it was calibrated against, not on an
 * abstraction.
 */

const shapes = (...ops: Array<[string, string]>): PathGrammarOperationShape[] =>
  ops.map(([method, path]) => ({ method, path }));

/** Plaid's grammar: verbs as plain terminal segments, method mix collapsed onto POST. */
const plaidShaped = shapes(
  ["post", "/transactions/get"],
  ["post", "/transactions/sync"],
  ["post", "/accounts/balance/get"],
  ["post", "/item/get"],
  ["post", "/item/remove"],
  ["post", "/asset_report/create"],
  ["post", "/asset_report/get"],
  ["post", "/asset_report/refresh"],
  ["post", "/link/token/create"],
  ["post", "/processor/token/create"],
);

/** Zendesk/GitHub-shaped REST: nouns in the path, methods carry the verb. */
const restShaped = shapes(
  ["get", "/api/v2/tickets"],
  ["post", "/api/v2/tickets"],
  ["get", "/api/v2/tickets/{ticket_id}"],
  ["put", "/api/v2/tickets/{ticket_id}"],
  ["delete", "/api/v2/tickets/{ticket_id}"],
  ["get", "/api/v2/users"],
  ["get", "/api/v2/users/{user_id}"],
  ["post", "/api/v2/users"],
);

/** Slack's grammar: the RPC method is declared in the URL as a dotted segment. */
const slackShaped = shapes(
  ["post", "/chat.postMessage"],
  ["get", "/conversations.list"],
  ["post", "/conversations.archive"],
  ["get", "/users.profile.get"],
);

/**
 * A genuinely split estate: every terminal segment is a CRUD verb and no path
 * carries a parameter (both RPC signals), yet the estate is GET-heavy (a REST
 * signal). Neither grammar explains all the evidence.
 */
const splitShaped = shapes(
  ["get", "/reports/get"],
  ["get", "/users/get"],
  ["get", "/orders/list"],
  ["get", "/invoices/count"],
);

describe("classifyPathGrammar", () => {
  it("classifies a REST estate as resource_grammar from the evidence", () => {
    const { grammar, diagnostics } = classifyPathGrammar("openapi", restShaped);
    expect(grammar.classification).toBe("resource_grammar");
    expect(grammar.basis).toBe("estate_evidence");
    expect(diagnostics).toEqual([]);
    expect(grammar.evidence).toEqual({
      operations: 8,
      readMethodOperations: 4,
      parameterizedPathOperations: 4,
      verbTerminalOperations: 0,
      dottedTerminalOperations: 0,
      repeatedVerbWords: 0,
    });
  });

  it("classifies a Plaid-shaped estate as rpc_plain from the evidence, not the source kind", () => {
    // The kind says openapi; the estate says RPC. The classifier must read the
    // estate — this is the 72%-defect case the whole module exists for.
    const { grammar, diagnostics } = classifyPathGrammar("openapi", plaidShaped);
    expect(grammar.classification).toBe("rpc_plain");
    expect(grammar.basis).toBe("estate_evidence");
    expect(diagnostics).toEqual([]);
    expect(grammar.evidence).toEqual({
      operations: 10,
      readMethodOperations: 0,
      parameterizedPathOperations: 0,
      verbTerminalOperations: 10,
      dottedTerminalOperations: 0,
      // get (transactions/, accounts/balance/, item/, asset_report/) and
      // create (asset_report/, link/token/, processor/token/) both terminate
      // two or more distinct parents.
      repeatedVerbWords: 2,
    });
  });

  it("names what decomposeSegment already does: dotted RPC estates classify rpc_dotted", () => {
    const { grammar, diagnostics } = classifyPathGrammar("openapi", slackShaped);
    expect(grammar.classification).toBe("rpc_dotted");
    expect(grammar.basis).toBe("estate_evidence");
    expect(diagnostics).toEqual([]);
    expect(grammar.evidence.dottedTerminalOperations).toBe(4);
  });

  it("classifies an adapter-lowered kind by construction, whatever its paths look like", () => {
    // NetSuite's WSDL lowers to /NetSuitePortType/get — path evidence that
    // SCREAMS rpc_plain. The kind is the stronger fact: the adapter declared
    // the shape, and the method name must stay the operation's identity.
    const lowered = shapes(
      ["post", "/NetSuitePortType/get"],
      ["post", "/NetSuitePortType/add"],
      ["post", "/NetSuitePortType/getAll"],
    );
    const { grammar, diagnostics } = classifyPathGrammar("wsdl", lowered);
    expect(grammar.classification).toBe("adapter_lowered");
    expect(grammar.basis).toBe("source_kind");
    expect(diagnostics).toEqual([]);
    // The counts are still recorded — the operator sees what the paths look
    // like even when they did not decide anything (`getAll` reads as a
    // bulk-qualified verb segment, so all three terminals count).
    expect(grammar.evidence.verbTerminalOperations).toBe(3);
  });

  it("declines with a diagnostic when the evidence genuinely splits — never a silent pick", () => {
    const { grammar, diagnostics } = classifyPathGrammar("openapi", splitShaped);
    expect(grammar.classification).toBe("ambiguous");
    expect(diagnostics).toHaveLength(1);
    const warning = diagnostics[0];
    expect(warning?.level).toBe("warning");
    expect(warning?.code).toBe("path_grammar_ambiguous");
    // The diagnostic names BOTH candidate grammars, the evidence for each, and
    // the manifest field that settles it.
    expect(warning?.message).toContain("rpc_plain");
    expect(warning?.message).toContain("resource_grammar");
    expect(warning?.message).toContain("4/4 operations end in a CRUD-verb segment");
    expect(warning?.message).toContain("4/4 operations use GET/HEAD");
    expect(warning?.message).toContain("path_grammar:");
  });

  it("stays quiet on an empty estate — ambiguous, but there is nothing to warn about", () => {
    const { grammar, diagnostics } = classifyPathGrammar("openapi", []);
    expect(grammar.classification).toBe("ambiguous");
    expect(diagnostics).toEqual([]);
  });
});

describe("manifest override (path_grammar)", () => {
  it("settles an ambiguous estate silently", () => {
    const { grammar, diagnostics } = classifyPathGrammar("openapi", splitShaped, "rpc_plain");
    expect(grammar.classification).toBe("rpc_plain");
    expect(grammar.basis).toBe("manifest");
    expect(diagnostics).toEqual([]);
  });

  it("applies a declaration that contradicts a definite verdict, but records the contradiction", () => {
    // The operator is allowed to know their API better than the counts — the
    // override wins — but the disagreement is a reviewable fact, not silence.
    const { grammar, diagnostics } = classifyPathGrammar(
      "openapi",
      plaidShaped,
      "resource_grammar",
    );
    expect(grammar.classification).toBe("resource_grammar");
    expect(grammar.basis).toBe("manifest");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe("warning");
    expect(diagnostics[0]?.code).toBe("path_grammar_override_contradicts_evidence");
    expect(diagnostics[0]?.message).toContain('"resource_grammar"');
    expect(diagnostics[0]?.message).toContain('"rpc_plain"');
  });

  it("does not warn when the declaration agrees with the evidence", () => {
    const { grammar, diagnostics } = classifyPathGrammar("openapi", plaidShaped, "rpc_plain");
    expect(grammar.classification).toBe("rpc_plain");
    expect(grammar.basis).toBe("manifest");
    expect(diagnostics).toEqual([]);
  });
});

describe("estateContextEnabled — the gate the classification drives", () => {
  const grammarOf = (
    classification:
      | "resource_grammar"
      | "rpc_plain"
      | "rpc_dotted"
      | "adapter_lowered"
      | "ambiguous",
  ) => ({
    classification,
    basis: "estate_evidence" as const,
    evidence: measurePathGrammarEvidence([]),
  });

  it("arms the re-homing rules for resource and plain-RPC grammars only", () => {
    expect(estateContextEnabled(grammarOf("resource_grammar"), "openapi")).toBe(true);
    expect(estateContextEnabled(grammarOf("rpc_plain"), "openapi")).toBe(true);
    expect(estateContextEnabled(grammarOf("rpc_dotted"), "openapi")).toBe(false);
    expect(estateContextEnabled(grammarOf("adapter_lowered"), "wsdl")).toBe(false);
  });

  it("falls back to the pre-classifier source-kind gate when ambiguous", () => {
    // Declining to guess must never change an estate's names: the fallback is
    // exactly the behavior the hardcoded kind list produced.
    for (const kind of ["openapi", "swagger", "discovery", "postman", "odata"] as const) {
      expect(estateContextEnabled(grammarOf("ambiguous"), kind)).toBe(true);
    }
    for (const kind of ["wsdl", "graphql", "protobuf", "mcp"] as const) {
      expect(estateContextEnabled(grammarOf("ambiguous"), kind)).toBe(false);
    }
  });
});

const specOf = (paths: string) => `openapi: 3.0.0
info: { title: svc, version: 1.0.0 }
paths:
${paths}`;

const plaidSpec = specOf(`  /transactions/get:
    post:
      operationId: transactionsGet
      responses: { "200": { description: ok } }
  /transactions/sync:
    post:
      operationId: transactionsSync
      responses: { "200": { description: ok } }
  /item/get:
    post:
      operationId: itemGet
      responses: { "200": { description: ok } }
  /item/remove:
    post:
      operationId: itemRemove
      responses: { "200": { description: ok } }
`);

describe("the compiled document carries the verdict", () => {
  it("declares the classification, basis, and counts in service.source.pathGrammar", async () => {
    const air = await compile({ spec: plaidSpec, serviceId: "plaid" });
    expect(air.service.source.pathGrammar).toEqual({
      classification: "rpc_plain",
      basis: "estate_evidence",
      evidence: {
        operations: 4,
        readMethodOperations: 0,
        parameterizedPathOperations: 0,
        verbTerminalOperations: 4,
        dottedTerminalOperations: 0,
        // `get` terminates both /transactions and /item; sync/remove one each.
        repeatedVerbWords: 1,
      },
    });
    // And the classification armed the re-homing rules: the verb segment is a
    // method, the collection before it is the resource.
    expect(air.operations.map((o) => o.effect.resource).sort()).toEqual([
      "item",
      "item",
      "transaction",
      "transaction",
    ]);
  });

  it("surfaces the ambiguity warning through compile and keeps today's naming", async () => {
    const air = await compile({
      spec: specOf(`  /reports/get:
    get:
      operationId: reportsGet
      responses: { "200": { description: ok } }
  /users/get:
    get:
      operationId: usersGet
      responses: { "200": { description: ok } }
`),
      serviceId: "svc",
    });
    expect(air.service.source.pathGrammar?.classification).toBe("ambiguous");
    expect(air.diagnostics.some((d) => d.code === "path_grammar_ambiguous")).toBe(true);
    // Fallback = the pre-classifier openapi behavior: estate context on, so
    // rule C still re-homes the trailing verb. Nothing broke by declining.
    expect(air.operations.map((o) => o.effect.resource).sort()).toEqual(["report", "user"]);
  });

  it("lets a manifest declaration drive the gate, recording a contradiction as a review signal", async () => {
    // Declaring a Plaid-shaped estate rpc_dotted disarms the re-homing rules:
    // the verb segments stay resources, exactly as an undeclared dotted estate
    // would be read — and the contradiction with the measured rpc_plain verdict
    // is a warning the operator can review, never a silent overrule.
    const air = await compile({
      spec: plaidSpec,
      serviceId: "plaid",
      manifest: "path_grammar: rpc_dotted\n",
    });
    expect(air.service.source.pathGrammar?.classification).toBe("rpc_dotted");
    expect(air.service.source.pathGrammar?.basis).toBe("manifest");
    expect(
      air.diagnostics.filter((d) => d.code === "path_grammar_override_contradicts_evidence"),
    ).toHaveLength(1);
    expect(air.operations.map((o) => o.effect.resource).sort()).toEqual([
      "get",
      "get",
      "remove",
      "sync",
    ]);
  });
});
