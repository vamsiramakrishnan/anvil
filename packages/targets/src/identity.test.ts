import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { expect, it } from "vitest";
import { generateIdentityKit } from "./identity.js";
import { listTargetKitVerifiers } from "./verify.js";

it("binds one profile to two services without changing operations or approvals", async () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../../examples/payments/openapi.yaml", import.meta.url)),
    "utf8",
  );
  const air = await compile({ spec: source });
  const before = JSON.stringify(air);
  const other = structuredClone(air);
  other.service.id = "other";
  const profile = {
    version: 1,
    id: "shared",
    authentication: {
      provider: "oidc",
      issuer: "https://id.example",
      audience: "https://mcp.example",
      jwksUri: "https://id.example/keys",
    },
    mapping: {
      tenant: { source: "fixed", value: "enterprise" },
      upstreamScopes: air.operations[0]!.auth.scopes,
    },
    authorization: {
      rules: [air, other].map((doc) => ({
        id: doc.service.id,
        service: doc.service.id,
        operations: [doc.operations[0]!.id],
        effect: "allow",
      })),
    },
  };
  const first = generateIdentityKit(air, profile);
  const second = generateIdentityKit(other, profile);
  expect(first.digest).toBe(second.digest);
  const verifier = listTargetKitVerifiers().find((value) => value.id === "identity")!;
  const files = Object.fromEntries(
    first.files.map((file) => [file.path, Buffer.from(file.bytes).toString("utf8")]),
  );
  expect(verifier.verify(air, files).ok).toBe(true);
  expect(verifier.verify(air, { ...files, "targets/identity/env.json": "{}" }).ok).toBe(false);
  expect(verifier.verify(air, { ...files, "targets/identity/extra.json": "{}" }).ok).toBe(false);

  const env = JSON.parse(
    Buffer.from(first.files.find((file) => file.path.endsWith("env.json"))!.bytes).toString(),
  );
  expect(JSON.parse(env.ANVIL_IDENTITY_PROFILE_JSON).id).toBe("shared");
  expect(JSON.stringify(air)).toBe(before);
  expect(first.files.some((file) => file.path.endsWith("terraform.tfvars.json"))).toBe(true);
  const bad = structuredClone(profile);
  bad.authorization.rules[0]!.operations = ["invented"];
  expect(() => generateIdentityKit(air, bad)).toThrow(/unknown operation/);
});
