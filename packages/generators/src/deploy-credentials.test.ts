import { type AirDocument, AuthRequirement } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { credentialContract, googleResourcePrefix } from "./deploy.js";

const A = (p: Partial<AuthRequirement> & { type: AuthRequirement["type"] }): AuthRequirement =>
  AuthRequirement.parse({ scopes: [], ...p });

/** A minimal AIR carrying only what credentialContract reads: service + op auth. */
function airWith(...auths: AuthRequirement[]): AirDocument {
  return {
    service: { id: "acme", environment: "prod", auth: A({ type: "none" }) },
    operations: auths.map((auth, i) => ({
      canonicalName: `op_${i}`,
      auth,
      state: "approved",
    })),
  } as unknown as AirDocument;
}

describe("credentialContract — outbound credential routing", () => {
  it("routes on-behalf-of to the delegated resolver (RFC 8693) with the token endpoint", () => {
    const c = credentialContract(
      airWith(A({ type: "oauth2_on_behalf_of", principal: "delegated" })),
    );
    const r = c.requirements[0];
    expect(r?.resolver).toBe("delegated");
    expect(r?.required).toContain("ANVIL_PROD_TOKEN_ENDPOINT");
    expect(r?.required).toContain("ANVIL_PROD_CLIENT_SECRET");
    expect(r?.optional).not.toContain("ANVIL_PROD_ACTOR_TOKEN");
    expect(r?.note).toMatch(/inbound caller token/i);
  });

  it("requires the actor token when AIR declares true delegation", () => {
    const c = credentialContract(
      airWith(
        A({
          type: "oauth2_on_behalf_of",
          principal: "delegated",
          delegation: { actor: "agent-service", subject: "end-user" },
        }),
      ),
    );
    expect(c.requirements[0]?.required).toContain("ANVIL_PROD_ACTOR_TOKEN");
    expect(c.requirements[0]?.optional).not.toContain("ANVIL_PROD_ACTOR_TOKEN");
  });

  it("routes client_credentials to the delegated resolver and swaps the secret for private_key_jwt", () => {
    const basic = credentialContract(airWith(A({ type: "oauth2_client_credentials" })));
    expect(basic.requirements[0]?.required).toContain("ANVIL_PROD_CLIENT_SECRET");
    const pkjwt = credentialContract(
      airWith(
        A({ type: "oauth2_client_credentials", provider: { clientAuth: "private_key_jwt" } }),
      ),
    );
    expect(pkjwt.requirements[0]?.required).toContain("ANVIL_PROD_CLIENT_ASSERTION_KEY");
    expect(pkjwt.requirements[0]?.required).not.toContain("ANVIL_PROD_CLIENT_SECRET");
  });

  it("requires explicit host admission or an endpoint override for an imported token endpoint", () => {
    const c = credentialContract(
      airWith(
        A({
          type: "oauth2_client_credentials",
          provider: {
            grant: "client_credentials",
            tokenEndpoint: "https://issuer.example/token",
          },
        }),
      ),
    );
    const requirement = c.requirements[0];
    expect(requirement?.required).not.toContain("ANVIL_PROD_TOKEN_ENDPOINT");
    expect(requirement?.requiredOneOf).toEqual([
      ["ANVIL_CREDENTIAL_HOSTS"],
      ["ANVIL_PROD_TOKEN_ENDPOINT"],
    ]);
    expect(requirement?.optional).toContain("ANVIL_CREDENTIAL_HOSTS");
  });

  it("classifies api_key under the env resolver with a configurable carrier", () => {
    const c = credentialContract(airWith(A({ type: "api_key" })));
    expect(c.requirements[0]?.resolver).toBe("env");
    expect(c.requirements[0]?.required).toEqual(["ANVIL_PROD_API_KEY"]);
    expect(c.requirements[0]?.optional).toContain("ANVIL_PROD_API_KEY_HEADER");
    expect(c.requirements[0]?.optional).toContain("ANVIL_PROD_API_KEY_QUERY");
  });

  it("classifies workload_identity with no client secret (the SA is the identity)", () => {
    const c = credentialContract(
      airWith(A({ type: "workload_identity", secretSource: "workload_identity" })),
    );
    expect(c.requirements[0]?.resolver).toBe("workload_identity");
    expect(c.requirements[0]?.required).toHaveLength(0);
    expect(c.requirements[0]?.optional).toContain("ANVIL_PROD_AUDIENCE");
  });

  it("dedupes by auth shape and lists every covered operation", () => {
    const c = credentialContract(
      airWith(A({ type: "api_key" }), A({ type: "api_key" }), A({ type: "basic" })),
    );
    expect(c.requirements).toHaveLength(2);
    expect(c.requirements.find((r) => r.auth === "api_key")?.operations).toEqual(["op_0", "op_1"]);
  });

  it("respects the profile in the env prefix", () => {
    const c = credentialContract(airWith(A({ type: "oauth2_client_credentials" })), "staging");
    expect(c.profileDefault).toBe("staging");
    expect(c.profileEnvVar).toBe("ANVIL_AUTH_PROFILE");
    expect(c.requirements[0]?.required).toContain("ANVIL_STAGING_TOKEN_ENDPOINT");
  });

  it("keeps distinct source security schemes in distinct credential namespaces", () => {
    const c = credentialContract(
      airWith(
        A({
          type: "api_key",
          credentialProfile: "partner_a_11111111111111111111111111111111",
        }),
        A({
          type: "api_key",
          credentialProfile: "partner_a_22222222222222222222222222222222",
        }),
      ),
    );
    expect(c.requirements).toHaveLength(2);
    expect(c.requirements.map((requirement) => requirement.profile)).toEqual([
      "prod_partner_a_11111111111111111111111111111111",
      "prod_partner_a_22222222222222222222222222222222",
    ]);
    expect(c.requirements[0]?.required).toEqual([
      "ANVIL_PROD_PARTNER_A_11111111111111111111111111111111_API_KEY",
    ]);
    expect(c.requirements[1]?.required).toEqual([
      "ANVIL_PROD_PARTNER_A_22222222222222222222222222222222_API_KEY",
    ]);
  });

  it("documents the sm:// reference grammar and the coarse override", () => {
    const c = credentialContract(airWith(A({ type: "api_key" })));
    expect(c.secretReferences).toMatch(/sm:\/\//);
    expect(c.coarseOverride).toMatch(/ANVIL_CREDENTIALS/);
  });

  it("skips auth: none operations entirely", () => {
    expect(credentialContract(airWith(A({ type: "none" }))).requirements).toHaveLength(0);
  });

  it("does not provision credentials for operations outside the approved surface", () => {
    const air = airWith(A({ type: "api_key" }));
    if (air.operations[0]) air.operations[0].state = "review_required";
    expect(credentialContract(air).requirements).toEqual([]);
  });
});

describe("googleResourcePrefix", () => {
  it("projects canonical underscores and long ids into one stable GCP-safe prefix", () => {
    expect(googleResourcePrefix("payments_api")).toMatch(/^payments-ap-[a-f0-9]{12}$/);
    expect(googleResourcePrefix("foo_bar")).not.toBe(googleResourcePrefix("foo-bar"));
    expect(googleResourcePrefix("foo-bar")).toBe("foo-bar");
    const long = googleResourcePrefix("a_very_long_canonical_service_identifier_for_history");
    expect(long).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    expect(long.length).toBeLessThanOrEqual(24);
    expect(`${long}-tools`.length).toBeLessThanOrEqual(30);
    expect(googleResourcePrefix("a_very_long_canonical_service_identifier_for_history")).toBe(long);
  });
});
