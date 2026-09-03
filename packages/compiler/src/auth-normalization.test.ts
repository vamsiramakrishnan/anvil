import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";

function spec(
  securitySchemes: Record<string, unknown>,
  security: Array<Record<string, string[]>>,
): string {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Auth API", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    components: { securitySchemes },
    security,
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          summary: "List items",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
}

describe("OpenAPI auth normalization", () => {
  it("preserves client-credential grant mechanics and service principal", async () => {
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              clientCredentials: {
                tokenUrl: "https://idp.example.com/token",
                scopes: { "items.read": "read" },
              },
            },
          },
        },
        [{ oauth: ["items.read"] }],
      ),
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth).toMatchObject({
      type: "oauth2_client_credentials",
      principal: "service",
      scopes: ["items.read"],
      credentialProfile: expect.stringMatching(/^oauth_[a-f0-9]{32}$/),
      provider: {
        grant: "client_credentials",
        tokenEndpoint: "https://idp.example.com/token",
      },
    });
  });

  it("keeps end-user authorization-code flow in review rather than minting as the service", async () => {
    // The runtime can now replay/refresh this grant (packages/runtime/src/
    // auth.ts), so it is no longer hard-blocked — but end-user authority is
    // still a human decision, never a material-completeness one, so it lands
    // at review_required, not "generated" straight to approvable.
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://idp.example.com/authorize",
                tokenUrl: "https://idp.example.com/token",
                scopes: { "items.read": "read" },
              },
            },
          },
        },
        [{ oauth: ["items.read"] }],
      ),
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth).toMatchObject({
      type: "oauth2_authorization_code",
      principal: "end_user",
    });
    expect(air.operations[0]?.state).toBe("review_required");
    expect(air.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "auth/end_user_flow_unexecutable",
    );
    const note = air.operations[0]?.reviewNotes.join(" ") ?? "";
    expect(note).toContain("anvil auth login");
  });

  it("preserves the API-key carrier", async () => {
    const air = await compile({
      spec: spec({ subscription: { type: "apiKey", in: "query", name: "subscription-key" } }, [
        { subscription: [] },
      ]),
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth).toMatchObject({
      type: "api_key",
      provider: { apiKey: { in: "query", name: "subscription-key" } },
    });
  });

  it("blocks an unrepresentable AND security expression", async () => {
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              clientCredentials: {
                tokenUrl: "https://idp.example.com/token",
                scopes: { "items.read": "read" },
              },
            },
          },
          subscription: { type: "apiKey", in: "header", name: "X-Subscription-Key" },
        },
        [{ oauth: ["items.read"], subscription: [] }],
      ),
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.operations[0]?.auth.type).toBe("custom_header");
    expect(air.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "auth/composite_unmodeled",
    );
  });

  it("selects the first of carrier-equivalent OR alternatives and gates it on review", async () => {
    // Coupa/Stripe shape: client-credentials OR api-key — both service authority,
    // so the alternative choice carries no safety weight.
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              clientCredentials: {
                tokenUrl: "https://idp.example.com/token",
                scopes: { "items.read": "read" },
              },
            },
          },
          subscription: { type: "apiKey", in: "header", name: "X-Subscription-Key" },
        },
        [{ oauth: ["items.read"] }, { subscription: [] }],
      ),
      serviceId: "auth-api",
    });
    const op = air.operations[0];
    expect(op?.auth).toMatchObject({
      type: "oauth2_client_credentials",
      principal: "service",
      provider: { grant: "client_credentials", tokenEndpoint: "https://idp.example.com/token" },
    });
    expect(op?.state).toBe("review_required");
    expect(op?.reviewNotes.join(" ")).toMatch(/Compiled the first \("oauth"\)/);
    expect(op?.reviewNotes.join(" ")).toMatch(/bypassing "subscription"/);
    expect(air.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "auth/alternative_selected",
    );
  });

  it("keeps blocking OR alternatives whose authorities differ", async () => {
    // service (api key) OR end_user (authorization code): selecting either
    // changes whose authority the call runs under — never implicit.
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://idp.example.com/authorize",
                tokenUrl: "https://idp.example.com/token",
                scopes: { "items.read": "read" },
              },
            },
          },
          subscription: { type: "apiKey", in: "header", name: "X-Subscription-Key" },
        },
        [{ subscription: [] }, { oauth: ["items.read"] }],
      ),
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "auth/alternatives_unmodeled",
    );
  });

  it("prefers the credentialed alternative over an anonymous one, with a note", async () => {
    const air = await compile({
      spec: spec({ subscription: { type: "apiKey", in: "header", name: "X-Subscription-Key" } }, [
        {},
        { subscription: [] },
      ]),
      serviceId: "auth-api",
    });
    const op = air.operations[0];
    expect(op?.auth.type).toBe("api_key");
    expect(op?.state).toBe("review_required");
    expect(op?.reviewNotes.join(" ")).toMatch(/anonymous alternative/);
  });

  it("keeps blocking OR alternatives when one is itself an AND composite", async () => {
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              clientCredentials: {
                tokenUrl: "https://idp.example.com/token",
                scopes: { "items.read": "read" },
              },
            },
          },
          subscription: { type: "apiKey", in: "header", name: "X-Subscription-Key" },
        },
        [{ oauth: ["items.read"], subscription: [] }, { subscription: [] }],
      ),
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "auth/alternatives_unmodeled",
    );
  });

  it("unblocks an end-user flow via the manifest OBO recipe the diagnostic prescribes", async () => {
    // The Workday/Zoho path: compile says blocked with a concrete recipe; an
    // operator models on-behalf-of delegation and the operation becomes
    // reviewable, with the imported token endpoint preserved for the exchange.
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://idp.example.com/authorize",
                tokenUrl: "https://idp.example.com/token",
                scopes: { "items.read": "read" },
              },
            },
          },
        },
        [{ oauth: ["items.read"] }],
      ),
      manifest: `
operations:
  listItems:
    auth:
      type: oauth2_on_behalf_of
    state: review_required
`,
      serviceId: "auth-api",
    });
    const op = air.operations[0];
    expect(op?.auth).toMatchObject({
      type: "oauth2_on_behalf_of",
      principal: "delegated",
      provider: { grant: "token_exchange", tokenEndpoint: "https://idp.example.com/token" },
    });
    expect(op?.state).toBe("review_required");
    // The blocking diagnostic names the exact unblock so nobody has to find it.
    const blockedMessage = air.diagnostics.find(
      (diagnostic) => diagnostic.code === "auth/end_user_flow_unexecutable",
    )?.message;
    expect(blockedMessage).toContain("oauth2_on_behalf_of");
  });

  it("lets a manifest author explicit provider mechanics without hand-editing AIR", async () => {
    const air = await compile({
      spec: spec({}, []),
      manifest: `
operations:
  listItems:
    auth:
      type: oauth2_client_credentials
      principal: service
      secret_source: secret_manager
      provider:
        grant: client_credentials
        token_endpoint: https://idp.example.com/token
        client_auth: private_key_jwt
        resource: https://items.example.com
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth).toMatchObject({
      type: "oauth2_client_credentials",
      principal: "service",
      secretSource: "secret_manager",
      provider: {
        grant: "client_credentials",
        tokenEndpoint: "https://idp.example.com/token",
        clientAuth: "private_key_jwt",
        resource: "https://items.example.com",
      },
    });
  });

  it("changes auth authority atomically and preserves imported endpoint mechanics", async () => {
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://idp.example.com/authorize",
                tokenUrl: "https://idp.example.com/token",
                scopes: { "items.read": "read" },
              },
            },
          },
        },
        [{ oauth: ["items.read"] }],
      ),
      manifest: `
operations:
  listItems:
    auth:
      type: oauth2_client_credentials
    state: approved
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth).toMatchObject({
      type: "oauth2_client_credentials",
      principal: "service",
      secretSource: "env",
      provider: {
        grant: "client_credentials",
        tokenEndpoint: "https://idp.example.com/token",
      },
    });
    expect(air.operations[0]?.state).toBe("approved");
  });

  it("blocks an explicit principal that disagrees with the selected wire grant", async () => {
    const air = await compile({
      spec: spec({}, []),
      manifest: `
operations:
  listItems:
    auth:
      type: oauth2_client_credentials
      principal: end_user
    state: approved
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.operations[0]?.reviewNotes.join(" ")).toMatch(/service authority/i);
  });

  it("merges a partial provider override instead of dropping the imported token endpoint", async () => {
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              clientCredentials: {
                tokenUrl: "https://idp.example.com/token",
                scopes: {},
              },
            },
          },
        },
        [{ oauth: [] }],
      ),
      manifest: `
operations:
  listItems:
    auth:
      provider:
        client_auth: private_key_jwt
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth.provider).toMatchObject({
      grant: "client_credentials",
      tokenEndpoint: "https://idp.example.com/token",
      clientAuth: "private_key_jwt",
    });
  });

  it("never lets a one-credential manifest remove a source-required AND factor", async () => {
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              clientCredentials: {
                tokenUrl: "https://idp.example.com/token",
                scopes: {},
              },
            },
          },
          subscription: { type: "apiKey", in: "header", name: "X-Subscription-Key" },
        },
        [{ oauth: [], subscription: [] }],
      ),
      manifest: `
operations:
  listItems:
    auth:
      type: oauth2_client_credentials
      provider:
        token_endpoint: https://idp.example.com/token
    state: approved
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.operations[0]?.reviewNotes.join(" ")).toMatch(/multiple security schemes/i);
  });

  it("keeps colliding normalized security-scheme names in separate credential profiles", async () => {
    const document = JSON.parse(
      spec(
        {
          "Partner OAuth": { type: "apiKey", in: "header", name: "X-Partner-A" },
          partner_oauth: { type: "apiKey", in: "header", name: "X-Partner-B" },
        },
        [{ "Partner OAuth": [] }],
      ),
    );
    document.paths["/other"] = {
      get: {
        operationId: "listOther",
        security: [{ partner_oauth: [] }],
        responses: { "200": { description: "ok" } },
      },
    };
    const air = await compile({ spec: JSON.stringify(document), serviceId: "auth-api" });
    const profiles = air.operations.map((operation) => operation.auth.credentialProfile);
    expect(new Set(profiles).size).toBe(2);
    expect(profiles).toEqual([
      expect.stringMatching(/^partner_o_?auth_[a-f0-9]{32}$/),
      expect.stringMatching(/^partner_oauth_[a-f0-9]{32}$/),
    ]);
  });

  it("blocks ambiguous legacy service oauth2 instead of silently leaving an operation open", async () => {
    const air = await compile({
      spec: spec({}, []),
      manifest: `
auth:
  type: oauth2
  scopes: [items.read]
operations:
  listItems:
    state: approved
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth.type).toBe("custom_header");
    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "auth/service_oauth2_ambiguous",
    );
  });

  it("remodels every end-user flow to on-behalf-of via one service-level manifest line", async () => {
    // The estate-scale version of the OBO recipe: Workday/Zoho declare
    // authorization-code on every operation, so per-operation entries would be
    // hundreds of lines. The service-level type remodel applies the same
    // narrow transformation everywhere and leaves each operation review-gated.
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://idp.example.com/authorize",
                tokenUrl: "https://idp.example.com/token",
                scopes: { "items.read": "read" },
              },
            },
          },
        },
        [{ oauth: ["items.read"] }],
      ),
      manifest: `
auth:
  type: oauth2_on_behalf_of
`,
      serviceId: "auth-api",
    });
    const op = air.operations[0];
    expect(op?.auth).toMatchObject({
      type: "oauth2_on_behalf_of",
      principal: "delegated",
      provider: { grant: "token_exchange", tokenEndpoint: "https://idp.example.com/token" },
    });
    expect(op?.state).toBe("review_required");
    expect(op?.reviewNotes.join(" ")).toMatch(/remodeled to on-behalf-of/);
    // The stale "unexecutable" recipe note is gone — one story per operation.
    expect(op?.reviewNotes.join(" ")).not.toMatch(/cannot use one shared runtime token/);
    expect(air.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "auth/end_user_flow_remodeled",
    );
  });

  it("never lets the service-level OBO remodel override a non-end-user contract", async () => {
    const air = await compile({
      spec: spec({ subscription: { type: "apiKey", in: "header", name: "X-Subscription-Key" } }, [
        { subscription: [] },
      ]),
      manifest: `
auth:
  type: oauth2_on_behalf_of
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth.type).toBe("api_key");
    expect(air.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "auth/service_default_not_applied",
    );
  });

  it("applies explicit same-type service credential storage policy", async () => {
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              clientCredentials: {
                tokenUrl: "https://idp.example.com/token",
                scopes: {},
              },
            },
          },
        },
        [{ oauth: [] }],
      ),
      manifest: `
auth:
  type: oauth2_client_credentials
  secret_source: secret_manager
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth).toMatchObject({
      type: "oauth2_client_credentials",
      principal: "service",
      secretSource: "secret_manager",
      provider: { tokenEndpoint: "https://idp.example.com/token" },
    });
  });

  it("applies type-independent service provider defaults when type is omitted", async () => {
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              clientCredentials: {
                tokenUrl: "https://idp.example.com/token",
                scopes: {},
              },
            },
          },
        },
        [{ oauth: [] }],
      ),
      manifest: `
auth:
  secret_source: secret_manager
  audience: https://items.example.com
  provider:
    client_auth: private_key_jwt
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth).toMatchObject({
      type: "oauth2_client_credentials",
      principal: "service",
      secretSource: "secret_manager",
      audience: "https://items.example.com",
      provider: {
        grant: "client_credentials",
        tokenEndpoint: "https://idp.example.com/token",
        clientAuth: "private_key_jwt",
      },
    });
  });
});

describe("mtls, custom_header, and oauth2_authorization_code: compiler unblock", () => {
  it("blocks a manifest-declared mtls operation that names no client certificate", async () => {
    const air = await compile({
      spec: spec({}, []),
      manifest: `
operations:
  listItems:
    auth:
      type: mtls
    state: approved
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth.type).toBe("mtls");
    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.operations[0]?.reviewNotes.join(" ")).toContain(
      "mtls auth must name its client certificate and key references",
    );
  });

  it("blocks a manifest-declared custom_header operation that names no carrier", async () => {
    const air = await compile({
      spec: spec({}, []),
      manifest: `
operations:
  listItems:
    auth:
      type: custom_header
    state: approved
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth.type).toBe("custom_header");
    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.operations[0]?.reviewNotes.join(" ")).toContain(
      "custom_header auth must name its credential carrier",
    );
  });

  it("compiles a coherent manifest-declared custom_header straight through, unblocked", async () => {
    const air = await compile({
      spec: spec({}, []),
      manifest: `
operations:
  listItems:
    auth:
      type: custom_header
      carrier:
        in: header
        name: X-Vendor-Token
`,
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.auth).toMatchObject({
      type: "custom_header",
      carrier: { in: "header", name: "X-Vendor-Token" },
    });
    // Never forced to blocked or even review — a complete custom_header
    // contract is exactly as approvable as api_key/basic always were.
    expect(air.operations[0]?.state).toBe("generated");
  });

  it("supplying coherent mtls material does not itself lift an unrelated block", async () => {
    // Two OR alternatives that disagree in principal (service vs end_user) —
    // AIR refuses to guess between them, so this compiles custom_header/blocked
    // with an `auth/alternatives_unmodeled` diagnostic, same as the dedicated
    // alternatives tests above. The manifest then REPLACES the whole contract
    // with a coherent mtls one — but a manifest's `state` and `auth` can be
    // merged from unrelated sources (a gateway-identity-contradiction guard
    // overlay sets `state: blocked` in the very same resolved manifest a
    // coherent auth patch rides in on), so a clean auth coherence result says
    // only "auth is not what's blocking it," never "nothing is." The operator
    // must lift the block explicitly (see the next test).
    const air = await compile({
      spec: spec(
        {
          apiKeyScheme: { type: "apiKey", in: "header", name: "X-API-Key" },
          oidc: { type: "openIdConnect", openIdConnectUrl: "https://idp.example.com/.well-known" },
        },
        [{ apiKeyScheme: [] }, { oidc: [] }],
      ),
      manifest: `
operations:
  listItems:
    auth:
      type: mtls
      tls:
        client_cert_ref: ANVIL_BANK_CLIENT_CERT
        client_key_ref: ANVIL_BANK_CLIENT_KEY
`,
      serviceId: "auth-api",
    });
    const op = air.operations[0];
    expect(op?.auth).toMatchObject({
      type: "mtls",
      principal: "service",
      tls: { clientCertRef: "ANVIL_BANK_CLIENT_CERT", clientKeyRef: "ANVIL_BANK_CLIENT_KEY" },
    });
    expect(op?.state).toBe("blocked");
  });

  it("lets an operator explicitly lift the block once mtls material is supplied", async () => {
    const air = await compile({
      spec: spec(
        {
          apiKeyScheme: { type: "apiKey", in: "header", name: "X-API-Key" },
          oidc: { type: "openIdConnect", openIdConnectUrl: "https://idp.example.com/.well-known" },
        },
        [{ apiKeyScheme: [] }, { oidc: [] }],
      ),
      manifest: `
operations:
  listItems:
    auth:
      type: mtls
      tls:
        client_cert_ref: ANVIL_BANK_CLIENT_CERT
        client_key_ref: ANVIL_BANK_CLIENT_KEY
    state: review_required
`,
      serviceId: "auth-api",
    });
    const op = air.operations[0];
    expect(op?.auth).toMatchObject({ type: "mtls" });
    expect(op?.state).toBe("review_required");
  });

  it("keeps authorization-code review_required even when the manifest asks for approved", async () => {
    const air = await compile({
      spec: spec(
        {
          oauth: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://idp.example.com/authorize",
                tokenUrl: "https://idp.example.com/token",
                scopes: { "items.read": "read" },
              },
            },
          },
        },
        [{ oauth: ["items.read"] }],
      ),
      manifest: `
operations:
  listItems:
    state: approved
`,
      serviceId: "auth-api",
    });
    // No manifest `auth:` key at all here — end-user authority forces
    // review_required unconditionally, regardless of what a manifest asked
    // for and regardless of how complete the material is.
    expect(air.operations[0]?.auth.type).toBe("oauth2_authorization_code");
    expect(air.operations[0]?.state).toBe("review_required");
    expect(air.operations[0]?.reviewNotes.join(" ")).toContain("never a material-completeness one");
  });
});
