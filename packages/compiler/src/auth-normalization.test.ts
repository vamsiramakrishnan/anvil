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

  it("blocks end-user authorization-code flow rather than minting as the service", async () => {
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
    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "auth/end_user_flow_unexecutable",
    );
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

  it.each([
    {
      name: "AND",
      security: [{ oauth: ["items.read"], subscription: [] }],
      code: "auth/composite_unmodeled",
    },
    {
      name: "OR",
      security: [{ oauth: ["items.read"] }, { subscription: [] }],
      code: "auth/alternatives_unmodeled",
    },
  ])("blocks an unrepresentable $name security expression", async ({ security, code }) => {
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
        security,
      ),
      serviceId: "auth-api",
    });
    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.operations[0]?.auth.type).toBe("custom_header");
    expect(air.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
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
