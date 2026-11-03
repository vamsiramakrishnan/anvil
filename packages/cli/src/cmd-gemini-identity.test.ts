import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

it("binds SiteMinder connector identity separately from Entra sign-in through the public CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "anvil-gemini-identity-"));
  try {
    const bundle = join(root, "bundle");
    const payments = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
    const compileIO = bufferIO();
    expect(
      await runAnvilCli(
        [
          "compile",
          join(payments, "openapi.yaml"),
          "--manifest",
          join(payments, "anvil.yaml"),
          "--out",
          bundle,
          "--root",
          root,
        ],
        { io: compileIO },
      ),
      compileIO.text(),
    ).toBe(0);
    const airText = readFileSync(join(bundle, "air.json"), "utf8");
    const air = JSON.parse(airText);
    const profile = {
      version: 1,
      id: "siteminder",
      authentication: {
        provider: "oidc",
        issuer: "https://siteminder.example/issuer",
        audience: "api://payments-mcp",
        resource: "https://payments-tools-123.run.app/mcp",
        jwksUri: "https://siteminder.example/keys",
        requiredScopes: ["mcp.invoke"],
      },
      mapping: {
        tenant: { source: "fixed", value: "tcs-demo" },
        upstreamScopes: air.operations[0].auth.scopes,
      },
      authorization: {
        rules: [
          {
            id: "read",
            service: air.service.id,
            operations: [air.operations[0].id],
            effect: "allow",
          },
        ],
      },
    };
    const path = join(root, "identity.json");
    writeFileSync(path, JSON.stringify(profile));
    const args = [
      "target",
      "gemini-enterprise",
      bundle,
      "--surface",
      "custom-mcp",
      "--server-auth",
      "oauth",
      "--endpoint",
      profile.authentication.resource,
      "--project",
      "tcs-demo",
      "--project-number",
      "123456789",
      "--location",
      "global",
      "--engine",
      "payments",
      "--idp",
      "other",
      "--oauth-authorization-url",
      "https://siteminder.example/authorize",
      "--oauth-token-url",
      "https://siteminder.example/token",
      "--oauth-scope",
      "mcp.invoke",
      "--wif",
      "locations/global/workforcePools/entra-users",
      "--identity-profile",
      path,
      "--json",
    ];
    const io = bufferIO();
    expect(await runAnvilCli(args, { io }), io.text()).toBe(0);
    const setupPath = join(bundle, "targets/gemini-enterprise/setup.json");
    const before = readFileSync(setupPath, "utf8");
    const setup = JSON.parse(before);
    expect(setup.config.workforcePool).toContain("entra-users");
    expect(setup.config.connectorOAuth.inboundIssuer).toBe(profile.authentication.issuer);
    expect(setup.config.identityProfile.id).toBe("siteminder");
    expect(readFileSync(join(bundle, "air.json"), "utf8")).toBe(airText);
    const badIO = bufferIO();
    expect(
      await runAnvilCli(
        [...args, "--inbound-issuer", "https://login.microsoftonline.com/entra/v2.0"],
        { io: badIO },
      ),
    ).toBe(1);
    expect(badIO.text()).toContain("target/identity_issuer_mismatch");
    expect(readFileSync(setupPath, "utf8")).toBe(before);
    writeFileSync(path, JSON.stringify({ ...profile, clientSecret: "do-not-echo-this-secret" }));
    const secretIO = bufferIO();
    expect(await runAnvilCli(args, { io: secretIO })).toBe(1);
    expect(secretIO.text()).not.toContain("do-not-echo-this-secret");
    expect(readFileSync(setupPath, "utf8")).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
