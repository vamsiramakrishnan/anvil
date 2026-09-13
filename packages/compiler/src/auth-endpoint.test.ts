import { expect, it } from "vitest";
import { authEndpoint } from "./auth-endpoint.js";
import { compile } from "./compile.js";

it("keeps an absolute OAuth authority independent of unresolved API server variables", () => {
  expect(
    authEndpoint({ servers: [{ url: "https://{domain}" }] }, "https://identity.example.com/token"),
  ).toBe("https://identity.example.com/token");
});

it.each([
  [
    "https://{domain}/api",
    { domain: { default: "tenant.example.com" } },
    "https://tenant.example.com/oauth/token",
  ],
  ["https://{domain}/api", {}, undefined],
  ["/api", {}, undefined],
])("resolves OAuth URLs only with declared authority: %s", async (url, variables, expected) => {
  const air = await compile({
    serviceId: "relative-auth",
    spec: JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Relative auth", version: "1" },
      servers: [{ url, variables }],
      components: {
        securitySchemes: {
          oauth: {
            type: "oauth2",
            flows: {
              clientCredentials: { tokenUrl: "/oauth/token", scopes: {} },
            },
          },
        },
      },
      security: [{ oauth: [] }],
      paths: {
        "/items": {
          get: { operationId: "listItems", responses: { "200": { description: "OK" } } },
        },
      },
    }),
  });
  expect(air.operations[0]?.auth.provider?.tokenEndpoint).toBe(expected);
  expect(air.operations[0]?.state === "blocked").toBe(!expected);
});
