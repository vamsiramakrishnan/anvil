import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthRequirement } from "@anvil/air";
import { GoogleAuth, Impersonated, OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, it } from "vitest";
import { GoogleWorkloadCredentials } from "./google-workload.js";
import { ConnectionVault, VaultCredentialResolver } from "./vault.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const workload = AuthRequirement.parse({
  type: "workload_identity",
  secretSource: "workload_identity",
  scopes: ["scope.read"],
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "anvil-adc-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const subject = join(dir, "subject.jwt");
  writeFileSync(subject, "fixture-external-subject");
  const forms: URLSearchParams[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    forms.push(new URLSearchParams(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        access_token: "fixture-google-access",
        token_type: "Bearer",
        expires_in: 3600,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address.");
  let constructions = 0;
  const provider = new GoogleWorkloadCredentials((scopes) => {
    constructions++;
    return new GoogleAuth({
      projectId: "fixture-project",
      scopes,
      credentials: {
        type: "external_account",
        audience:
          "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/test/providers/test",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: `http://127.0.0.1:${address.port}/token`,
        credential_source: { file: subject },
      },
    });
  });
  const vault = new ConnectionVault(join(dir, "vault"), Buffer.alloc(32, 9));
  const resolver = new VaultCredentialResolver(vault, () => undefined, { workload: provider });
  return { provider, resolver, forms, constructions: () => constructions };
}

describe("gateway Google workload ADC", () => {
  it("exchanges a real external_account subject through the official library and caches by scopes/connector", async () => {
    const f = await fixture();
    expect(
      await f.resolver.resolve("prod", workload, { principalId: "owner", connector: "docs" }),
    ).toEqual({ headers: { Authorization: "Bearer fixture-google-access" } });
    expect(f.forms).toHaveLength(1);
    expect(f.forms[0]?.get("subject_token")).toBe("fixture-external-subject");
    expect(f.forms[0]?.get("scope")).toBe("scope.read");
    await f.provider.resolve("docs", "prod", workload);
    expect(f.forms).toHaveLength(1);
    await f.provider.resolve("sheets", "prod", workload);
    await f.provider.resolve("docs", "prod", { ...workload, scopes: ["scope.write"] });
    expect(f.constructions()).toBe(3);
    expect(f.forms).toHaveLength(3);
  });

  it("uses official impersonation for audience-bound ID tokens without borrowing the caller token", async () => {
    const requests: Array<{ body: unknown; authorization: string | undefined }> = [];
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url");
    const idToken = `fixture.${payload}.signature`;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ body: JSON.parse(body), authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: idToken }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address.");
    const source = new OAuth2Client();
    source.setCredentials({
      access_token: "fixture-source-workload",
      expiry_date: Date.now() + 3600_000,
    });
    const provider = new GoogleWorkloadCredentials(
      () =>
        new GoogleAuth({
          authClient: new Impersonated({
            sourceClient: source,
            targetPrincipal: "service@fixture.iam.gserviceaccount.com",
            targetScopes: [],
            endpoint: `http://127.0.0.1:${address.port}`,
          }),
        }),
    );
    const material = await provider.resolve("mcp", "prod", {
      ...workload,
      audience: "https://protected.example/mcp",
    });
    expect(material.headers?.Authorization).toBe(`Bearer ${idToken}`);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe("Bearer fixture-source-workload");
    expect(requests[0]?.body).toMatchObject({ audience: "https://protected.example/mcp" });
  });

  it("never falls back from an unconnected human account to workload identity", async () => {
    const f = await fixture();
    await expect(
      f.resolver.resolve(
        "prod",
        { ...workload, type: "oauth2_authorization_code", secretSource: "env" },
        { principalId: "owner", connector: "docs" },
      ),
    ).rejects.toMatchObject({ details: { code: "connector/not_connected" } });
    expect(f.constructions()).toBe(0);
    expect(f.forms).toHaveLength(0);
    await expect(
      f.provider.resolve("docs", "prod", { ...workload, secretSource: "env" }),
    ).rejects.toMatchObject({ details: { code: "connector/unsupported_auth" } });
  });
});
