import { IdentityProfile } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { expect, it } from "vitest";
import { createGeminiEnterpriseTargetConfig } from "./config.js";
import { GEMINI_ENTERPRISE_PROFILE } from "./gemini-enterprise.js";
import { generateTargetKit } from "./generate.js";
import { generateIdentityKit } from "./identity.js";
import { prepareIdentityBinding } from "./identity-setup.js";
import { listTargetKitVerifiers } from "./verify.js";

it("regenerates existing Gemini deployment inputs with an identity profile as one paired kit", async () => {
  const compiled = await compile({
    serviceId: "test-system",
    spec: `openapi: 3.0.3
info: {title: Test, version: "1"}
paths:
  /records:
    get:
      operationId: listRecords
      description: Read test records.
      responses: {"200": {description: OK}}
`,
  });
  const air = approveOperations(
    compiled,
    compiled.operations.map((operation) => operation.id),
  );
  const endpoint = "https://test-tools-123.run.app/mcp";
  const profile = IdentityProfile.parse({
    version: 1,
    id: "siteminder",
    authentication: {
      provider: "oidc",
      issuer: "https://siteminder.example/issuer",
      audience: "api://test-mcp",
      resource: endpoint,
      jwksUri: "https://siteminder.example/keys",
      requiredScopes: ["mcp.invoke"],
    },
    mapping: { tenant: { source: "fixed", value: "test" } },
    authorization: {
      rules: [
        {
          id: "read",
          service: air.service.id,
          operations: [air.operations[0]!.id],
          effect: "allow",
        },
      ],
    },
  });
  const config = createGeminiEnterpriseTargetConfig({
    surface: "custom-mcp",
    serverAuth: "oauth",
    endpoint,
    project: "example-org-demo",
    projectNumber: "123456789",
    appLocation: "global",
    engine: "test-records",
    connectorOAuth: {
      provider: "other",
      authorizationUrl: "https://siteminder.example/authorize",
      tokenUrl: "https://siteminder.example/token",
      scopes: ["mcp.invoke"],
      inboundIssuer: profile.authentication.issuer,
      inboundAudience: profile.authentication.audience,
    },
  });
  const legacy = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, config);
  const files = Object.fromEntries(
    legacy.files.map((file) => [file.path, Buffer.from(file.bytes).toString("utf8")]),
  );
  const before = JSON.stringify(files);
  const airBefore = JSON.stringify(air);
  const paired = prepareIdentityBinding(air, profile, files);
  const next = {
    ...files,
    ...Object.fromEntries(
      paired.files.map((file) => [file.path, Buffer.from(file.bytes).toString("utf8")]),
    ),
  };
  expect(paired.files.some((file) => file.path.startsWith("targets/identity/"))).toBe(true);
  expect(next["targets/gemini-enterprise/inbound-auth.env"]).not.toContain(
    "ANVIL_INBOUND_AUTH_MODE=",
  );
  expect(next["targets/gemini-enterprise/terraform/cloud-run.tfvars"]).toContain(
    "allow_unauthenticated = false",
  );
  for (const id of ["identity", "gemini-enterprise"])
    expect(
      listTargetKitVerifiers()
        .find((verifier) => verifier.id === id)!
        .verify(air, next).ok,
    ).toBe(true);
  expect(JSON.stringify(files)).toBe(before);
  expect(JSON.stringify(air)).toBe(airBefore);

  const changed = structuredClone(profile);
  changed.authorization.rules[0]!.groups = ["reviewers"];
  const regenerated = prepareIdentityBinding(air, changed, next);
  const setup = JSON.parse(
    Buffer.from(
      regenerated.files.find((file) => file.path === "targets/gemini-enterprise/setup.json")!.bytes,
    ).toString("utf8"),
  );
  expect(setup.config.identityProfile.authorization.rules[0].groups).toEqual(["reviewers"]);
  const newScope = structuredClone(profile);
  newScope.authentication.requiredScopes.push("extra.scope");
  expect(() => prepareIdentityBinding(air, newScope, next)).toThrow(/conflict/);
  const otherAuthority = structuredClone(profile);
  otherAuthority.authentication.issuer = "https://different.example/issuer";
  expect(() => prepareIdentityBinding(air, otherAuthority, next)).toThrow(/conflict/);
  expect(JSON.parse(next["targets/gemini-enterprise/setup.json"]!).config.identityProfile).toEqual(
    profile,
  );
  const mismatched = {
    ...next,
    ...Object.fromEntries(
      generateIdentityKit(air, changed).files.map((file) => [
        file.path,
        Buffer.from(file.bytes).toString("utf8"),
      ]),
    ),
  };
  for (const id of ["identity", "gemini-enterprise"])
    expect(
      listTargetKitVerifiers()
        .find((verifier) => verifier.id === id)!
        .verify(air, mismatched)
        .findings.some((finding) => finding.detail.includes("profiles differ")),
    ).toBe(true);
});
