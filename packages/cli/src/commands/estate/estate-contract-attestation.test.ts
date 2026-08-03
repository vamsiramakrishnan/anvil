import type { Operation } from "@anvil/air";
import type { GatewayArtifactEvidence, GatewayDiagnostic } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import {
  attestGatewayRouteSet,
  attestRuntimeCoordinate,
  resolveFormalDefinitionLineage,
} from "./estate-contract-attestation.js";

/**
 * These four codes — `route_set_ambiguous`, `formal_definition_source_missing`,
 * `unnecessary_spec_override`, `runtime_coordinate_attested` — had no assertion
 * anywhere in the workspace. Not because they were unimportant, but because they
 * were unreachable: pure decisions buried inside `runImport`, reachable only by
 * driving the whole CLI with a fixture elaborate enough to hit one branch.
 *
 * The claim they collectively defend: a supplied contract is authoritative for
 * API shape and nothing else. It does not prove gateway membership, it does not
 * prove calls still traverse the gateway, and matching routes is not matching
 * bytes.
 */

const LOCATION = { origin: "/export.zip", pointer: "/services/0" };

function op(over: Partial<Operation> & { id: string }): Operation {
  return {
    sourceRef: { kind: "openapi", method: "get", path: "/things" },
    ...over,
  } as Operation;
}

const codesOf = (d: readonly GatewayDiagnostic[]) => d.map((x) => x.code);

/* -------------------------------------------------------------------------- */
/* Route-set attestation                                                       */
/* -------------------------------------------------------------------------- */

describe("attestGatewayRouteSet", () => {
  it("attests silently when the contract describes exactly the gateway's routes", () => {
    const gateway = [op({ id: "g1" })];
    const supplied = [op({ id: "s1" })];
    expect(attestGatewayRouteSet(gateway, supplied, LOCATION)).toEqual([]);
  });

  it("reports a gateway operation with no attestable method/path coordinate", () => {
    const gateway = [op({ id: "g1", sourceRef: { kind: "openapi" } as Operation["sourceRef"] })];
    const found = attestGatewayRouteSet(gateway, [], LOCATION);
    expect(codesOf(found)).toContain("gateway/route_set_ambiguous");
    expect(found[0]?.message).toContain("Gateway operation 'g1'");
    expect(found[0]?.coordinate).toEqual(LOCATION);
  });

  it("reports a supplied operation with no attestable coordinate, distinctly", () => {
    const supplied = [op({ id: "s1", sourceRef: { kind: "openapi" } as Operation["sourceRef"] })];
    const found = attestGatewayRouteSet([], supplied, LOCATION);
    expect(codesOf(found)).toEqual(["gateway/route_set_ambiguous"]);
    expect(found[0]?.message).toContain("Supplied contract operation 's1'");
  });

  it("refuses to guess when one side maps a route more than once", () => {
    const twice = [op({ id: "g1" }), op({ id: "g2" })];
    const once = [op({ id: "s1" })];

    const gatewayDup = attestGatewayRouteSet(twice, once, LOCATION);
    expect(codesOf(gatewayDup)).toContain("gateway/route_set_ambiguous");
    expect(gatewayDup.find((d) => d.code === "gateway/route_set_ambiguous")?.message).toContain(
      "appears 2 times",
    );

    const contractDup = attestGatewayRouteSet(once, twice, LOCATION);
    expect(contractDup.find((d) => d.code === "gateway/route_set_ambiguous")?.message).toContain(
      "Supplied contract route",
    );
  });

  it("distinguishes a contract that is missing routes from one that adds them", () => {
    const two = [
      op({ id: "g1" }),
      op({ id: "g2", sourceRef: { kind: "openapi", method: "post", path: "/things" } }),
    ];
    const one = [op({ id: "s1" })];

    expect(codesOf(attestGatewayRouteSet(two, one, LOCATION))).toContain(
      "gateway/route_set_missing",
    );
    expect(codesOf(attestGatewayRouteSet(one, two, LOCATION))).toContain("gateway/route_set_extra");
  });

  /**
   * Metamorphic: the attestation compares route *multisets*, so it must not
   * depend on the order operations arrive in. A route-set check that flipped
   * with input order would be a coin toss dressed as a safety gate.
   */
  it("does not depend on the order operations are supplied in", () => {
    const gateway = [
      op({ id: "g1" }),
      op({ id: "g2", sourceRef: { kind: "openapi", method: "post", path: "/things" } }),
      op({ id: "g3", sourceRef: { kind: "openapi", method: "get", path: "/others" } }),
    ];
    const supplied = [op({ id: "s1" })];
    const forward = attestGatewayRouteSet(gateway, supplied, LOCATION);
    const reversed = attestGatewayRouteSet([...gateway].reverse(), supplied, LOCATION);
    expect(reversed).toEqual(forward);
  });

  /** Path parameters are positional, so `{id}` and `{thingId}` are the same route. */
  it("treats differently-named path parameters as the same route", () => {
    const gateway = [
      op({ id: "g1", sourceRef: { kind: "openapi", method: "get", path: "/t/{id}" } }),
    ];
    const supplied = [
      op({ id: "s1", sourceRef: { kind: "openapi", method: "get", path: "/t/{thingId}" } }),
    ];
    expect(attestGatewayRouteSet(gateway, supplied, LOCATION)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Formal-definition lineage                                                   */
/* -------------------------------------------------------------------------- */

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const artifact = (digest: string, path = "Definitions/openapi.yaml"): GatewayArtifactEvidence =>
  ({ role: "formal_definition", origin: "/export.zip", path, digest }) as GatewayArtifactEvidence;

describe("resolveFormalDefinitionLineage", () => {
  it("refuses when the locked entrypoint is absent from its own source manifest", () => {
    const result = resolveFormalDefinitionLineage({
      formalDefinitions: [artifact(DIGEST_A)],
      supplied: undefined,
    });
    expect(result).toMatchObject({
      rejection: { code: "gateway/formal_definition_source_missing" },
    });
  });

  it("binds lineage when the supplied contract is byte-identical to the one definition", () => {
    const result = resolveFormalDefinitionLineage({
      formalDefinitions: [artifact(DIGEST_A)],
      supplied: { path: "api.yaml", digest: DIGEST_A },
    });
    expect(result).toMatchObject({ lineage: { mode: "embedded_digest_match" } });
  });

  it("refuses an override that was not needed, rather than recording a false claim", () => {
    const result = resolveFormalDefinitionLineage({
      formalDefinitions: [artifact(DIGEST_A)],
      supplied: { path: "api.yaml", digest: DIGEST_A },
      attestationReason: "reviewed by SRE",
    });
    expect(result).toMatchObject({ rejection: { code: "gateway/unnecessary_spec_override" } });
    if (!("rejection" in result)) throw new Error("expected a rejection");
    expect(result.rejection.message).toContain("Remove `--attest-spec-override`");
    expect(result.rejection.details).toMatchObject({ supplied: { digest: DIGEST_A } });
  });

  it("records an operator override when the digests genuinely differ", () => {
    const result = resolveFormalDefinitionLineage({
      formalDefinitions: [artifact(DIGEST_A)],
      supplied: { path: "api.yaml", digest: DIGEST_B },
      attestationReason: "legitimate external contract",
    });
    expect(result).toMatchObject({
      lineage: {
        mode: "operator_override",
        override: { attestation: "operator", reason: "legitimate external contract" },
      },
    });
  });

  it("names precisely why lineage cannot be established without an override", () => {
    const cases: Array<[GatewayArtifactEvidence[], string]> = [
      [[], "gateway/formal_definition_missing"],
      [
        [artifact(DIGEST_A), artifact(DIGEST_B, "Definitions/swagger.yaml")],
        "gateway/formal_definition_ambiguous",
      ],
      [[artifact(DIGEST_A)], "gateway/formal_definition_digest_mismatch"],
    ];
    for (const [formalDefinitions, code] of cases) {
      const result = resolveFormalDefinitionLineage({
        formalDefinitions,
        supplied: { path: "api.yaml", digest: DIGEST_B },
      });
      expect(result, code).toMatchObject({ rejection: { code } });
    }
  });

  it("never infers which of several definitions is authoritative", () => {
    // Even when one of them matches, more than one candidate means no exact match.
    const result = resolveFormalDefinitionLineage({
      formalDefinitions: [artifact(DIGEST_A), artifact(DIGEST_B, "Definitions/swagger.yaml")],
      supplied: { path: "api.yaml", digest: DIGEST_A },
    });
    expect(result).toMatchObject({ rejection: { code: "gateway/formal_definition_ambiguous" } });
  });

  it("says plainly that route compatibility is not byte lineage", () => {
    const result = resolveFormalDefinitionLineage({
      formalDefinitions: [artifact(DIGEST_A)],
      supplied: { path: "api.yaml", digest: DIGEST_B },
    });
    if (!("rejection" in result)) throw new Error("expected a rejection");
    expect(result.rejection.message).toContain("Route compatibility is not byte lineage");
  });
});

/* -------------------------------------------------------------------------- */
/* Runtime-coordinate attestation                                              */
/* -------------------------------------------------------------------------- */

describe("attestRuntimeCoordinate", () => {
  const missing: GatewayDiagnostic = {
    level: "warning",
    code: "gateway/missing_runtime_coordinate",
    message: "no runtime coordinate",
    coordinate: LOCATION,
  };
  const unrelated: GatewayDiagnostic = {
    level: "warning",
    code: "gateway/route_only_contract",
    message: "route only",
    coordinate: LOCATION,
  };

  it("leaves diagnostics untouched when no URL was attested", () => {
    expect(attestRuntimeCoordinate([missing, unrelated], undefined, LOCATION)).toEqual([
      missing,
      unrelated,
    ]);
  });

  it("supersedes the missing-coordinate warning rather than sitting beside it", () => {
    const found = attestRuntimeCoordinate([missing, unrelated], "https://gw.example/", LOCATION);
    expect(codesOf(found)).toEqual([
      "gateway/route_only_contract",
      "gateway/runtime_coordinate_attested",
    ]);
    // Leaving both would make the receipt contradict itself.
    expect(codesOf(found)).not.toContain("gateway/missing_runtime_coordinate");
  });

  it("narrows exactly one code and adds exactly one", () => {
    const noise: GatewayDiagnostic[] = [unrelated, missing, unrelated, missing];
    const found = attestRuntimeCoordinate(noise, "https://gw.example/", LOCATION);
    expect(found).toHaveLength(3);
    expect(codesOf(found).filter((c) => c === "gateway/route_only_contract")).toHaveLength(2);
  });

  it("records the attested URL and is informational, not a warning", () => {
    const [attested] = attestRuntimeCoordinate([], "https://gw.example/base", LOCATION);
    expect(attested?.level).toBe("info");
    expect(attested?.message).toContain("https://gw.example/base");
    expect(attested?.coordinate).toEqual(LOCATION);
  });

  it("does not mutate the diagnostics it was given", () => {
    const input: GatewayDiagnostic[] = [missing];
    attestRuntimeCoordinate(input, "https://gw.example", LOCATION);
    expect(input).toEqual([missing]);
  });
});
