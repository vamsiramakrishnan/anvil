import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IdentityProfile } from "@anvil/air";
import { approveOperationsInBundle, bundleHash, readBundleDir } from "@anvil/generators";
import {
  createGeminiEnterpriseTargetConfig,
  GEMINI_ENTERPRISE_PROFILE,
  generateIdentityKit,
  generateTargetKit,
  writeTargetKitAtomically,
} from "@anvil/targets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSOLE_ROUTES } from "../contract.js";
import { loadAir, paymentsWorkspace, startServer } from "./fixture.js";
import { validateIdentity } from "./identity.js";

let workspace: Awaited<ReturnType<typeof paymentsWorkspace>>;
let running: Awaited<ReturnType<typeof startServer>>;

beforeEach(async () => {
  workspace = await paymentsWorkspace();
  running = await startServer(workspace.root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await running?.server.close();
  if (workspace) rmSync(workspace.root, { recursive: true, force: true });
});

const route = (suffix = "") => `/api/bundles/payments/identity${suffix}`;
const digest = () => bundleHash(readBundleDir(workspace.bundleDir));
function profile() {
  const operation = workspace.air.operations[0]!;
  return {
    version: 1,
    id: "ultimatix",
    authentication: {
      provider: "oidc",
      issuer: "https://siteminder.example.com",
      audience: "https://ultimatix-mcp.example.com",
      resource: "https://ultimatix-mcp.example.com/mcp",
      jwksUri: "https://siteminder.example.com/keys",
    },
    mapping: { tenant: { source: "fixed", value: "tcs" }, upstreamScopes: operation.auth.scopes },
    authorization: {
      rules: [
        {
          id: "read",
          service: workspace.air.service.id,
          operations: [operation.id],
          effect: "allow",
        },
      ],
    },
  };
}

describe("identity configuration console parity", () => {
  it("reads absence and validates through the shared generator without network or writes", async () => {
    const before = readBundleDir(workspace.bundleDir);
    const response = await running.client.get(route());
    expect(response.status).toBe(200);
    expect(CONSOLE_ROUTES.identity.response.parse(response.json)).toMatchObject({
      configured: false,
      integrity: { state: "missing", findings: [] },
      verifiedLive: false,
    });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network"));
    const validation = validateIdentity(workspace.root, "payments", {
      bundleHash: digest(),
      profile: profile(),
    });
    expect(validation.ok).toBe(true);
    expect(validation.profileDigest).toBe(generateIdentityKit(workspace.air, profile()).digest);
    expect(validation.files).toEqual(
      generateIdentityKit(workspace.air, profile()).files.map((f) => f.path),
    );
    expect(network).not.toHaveBeenCalled();
    expect(readBundleDir(workspace.bundleDir)).toEqual(before);
  });

  it("installs byte-identical CLI kit files without approving or changing AIR", async () => {
    const air = loadAir(workspace.bundleDir);
    const before = readBundleDir(workspace.bundleDir);
    const response = await running.client.post(route(), {
      bundleHash: digest(),
      profile: profile(),
    });
    expect(response.status).toBe(200);
    const result = CONSOLE_ROUTES.applyIdentity.response.parse(response.json);
    expect(result).toMatchObject({
      written: true,
      identity: { integrity: { state: "fresh" }, verifiedLive: false },
    });
    const expected = generateIdentityKit(air, profile());
    for (const file of expected.files)
      expect(readFileSync(join(workspace.bundleDir, file.path), "utf8")).toBe(
        Buffer.from(file.bytes).toString("utf8"),
      );
    for (const [path, bytes] of Object.entries(before))
      expect(readBundleDir(workspace.bundleDir)[path]).toBe(bytes);
    expect(loadAir(workspace.bundleDir)).toEqual(air);
    expect(result.identity.bundleHash).toBe(digest());
    const listing = CONSOLE_ROUTES.artifacts.response.parse(
      (await running.client.get("/api/bundles/payments/artifacts")).json,
    );
    expect(listing.files.map((file) => file.path)).toContain("targets/identity/profile.json");
  });

  it("refuses stale drafts, unknown operations and raw secret fields without replacing a kit", async () => {
    const old = digest();
    expect(
      (await running.client.post(route(), { bundleHash: old, profile: profile() })).status,
    ).toBe(200);
    const before = readBundleDir(workspace.bundleDir);
    for (const suffix of ["", "/validate"])
      expect(
        (await running.client.post(route(suffix), { bundleHash: old, profile: profile() })).status,
      ).toBe(409);
    const invalid = profile();
    invalid.authorization.rules[0]!.operations = ["unknown-operation"];
    const validation = await running.client.post(route("/validate"), {
      bundleHash: digest(),
      profile: invalid,
    });
    expect(CONSOLE_ROUTES.validateIdentity.response.parse(validation.json).ok).toBe(false);
    expect(
      (await running.client.post(route(), { bundleHash: digest(), profile: invalid })).status,
    ).toBe(422);
    const secret = "never-return-this-client-secret";
    const raw = { ...profile(), clientSecret: secret };
    const refused = await running.client.post(route("/validate"), {
      bundleHash: digest(),
      profile: raw,
    });
    expect(CONSOLE_ROUTES.validateIdentity.response.parse(refused.json).ok).toBe(false);
    expect(refused.text).not.toContain(secret);
    expect(readBundleDir(workspace.bundleDir)).toEqual(before);
  });

  it("reports tampering in identity and assurance, hides unsafe artifacts and repairs deterministically", async () => {
    await running.client.post(route(), { bundleHash: digest(), profile: profile() });
    writeFileSync(
      join(workspace.bundleDir, "targets/identity/profile.json"),
      '{"clientSecret":"hidden-secret"}',
    );
    const response = await running.client.get(route());
    expect(CONSOLE_ROUTES.identity.response.parse(response.json).integrity.state).toBe("stale");
    expect(response.text).not.toContain("hidden-secret");
    const assurance = CONSOLE_ROUTES.assurance.response.parse(
      (await running.client.get("/api/bundles/payments/assurance")).json,
    );
    expect(assurance.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "contract.target-kit-exact.identity", status: "failed" }),
      ]),
    );
    const evidence = CONSOLE_ROUTES.evidence.response.parse(
      (await running.client.get("/api/bundles/payments/evidence")).json,
    );
    expect(evidence.staticChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "contract.target-kit-exact.identity", status: "failed" }),
      ]),
    );
    const artifact = await running.client.get(
      "/api/bundles/payments/artifact?path=targets%2Fidentity%2Fprofile.json",
    );
    expect(artifact.status).toBe(404);
    expect(artifact.text).not.toContain("hidden-secret");
    expect(
      (await running.client.post(route(), { bundleHash: digest(), profile: profile() })).status,
    ).toBe(200);
    expect(
      CONSOLE_ROUTES.identity.response.parse((await running.client.get(route())).json).integrity
        .state,
    ).toBe("fresh");
  });

  it("never reflects invalid persisted profiles and refuses symlink-backed configuration", async () => {
    mkdirSync(join(workspace.bundleDir, "targets/identity"), { recursive: true });
    writeFileSync(
      join(workspace.bundleDir, "targets/identity/setup.json"),
      '{"config":{"clientSecret":"hidden-secret"}}',
    );
    const response = await running.client.get(route());
    expect(CONSOLE_ROUTES.identity.response.parse(response.json)).toMatchObject({
      integrity: { state: "invalid" },
    });
    expect(response.text).not.toContain("hidden-secret");
    const outside = join(workspace.root, "external-identity");
    mkdirSync(outside);
    writeFileSync(join(outside, "private.txt"), "outside-secret");
    rmSync(join(workspace.bundleDir, "targets/identity"), { recursive: true });
    symlinkSync(outside, join(workspace.bundleDir, "targets/identity"));
    expect((await running.client.get(route())).status).toBe(409);
    expect(
      (await running.client.post(route(), { bundleHash: "stale", profile: profile() })).status,
    ).toBe(409);
    expect(readFileSync(join(outside, "private.txt"), "utf8")).toBe("outside-secret");
  });

  it("keeps token, same-origin and strict request gates on validation and installation", async () => {
    for (const suffix of ["", "/validate"]) {
      expect((await running.client.post(route(suffix), {}, { token: null })).status).toBe(403);
      expect(
        (await running.client.post(route(suffix), {}, { origin: "https://untrusted.example" }))
          .status,
      ).toBe(403);
      expect(
        (
          await running.client.post(route(suffix), {
            bundleHash: digest(),
            profile: profile(),
            token: "not-accepted",
          })
        ).status,
      ).toBe(400);
    }
  });

  it("reads a Gemini-only identity snapshot and refuses credential-free request previews", async () => {
    approveOperationsInBundle(workspace.bundleDir, [workspace.air.operations[0]!.id]);
    workspace.air = loadAir(workspace.bundleDir);
    const identity = IdentityProfile.parse(profile());
    const config = createGeminiEnterpriseTargetConfig({
      surface: "custom-mcp",
      serverAuth: "oauth",
      endpoint: "https://ultimatix-mcp.example.com/mcp",
      project: "tcs-test",
      projectNumber: "123456789012",
      appLocation: "global",
      engine: "test-engine",
      workforcePool: "locations/global/workforcePools/tcs-entra",
      connectorOAuth: {
        provider: "other",
        authorizationUrl: "https://siteminder.example.com/authorize",
        tokenUrl: "https://siteminder.example.com/token",
        scopes: ["mcp.invoke"],
      },
      identityProfile: identity,
    });
    const kit = generateTargetKit(workspace.air, GEMINI_ENTERPRISE_PROFILE, config);
    writeTargetKitAtomically(workspace.bundleDir, "gemini-enterprise", kit.files, {});
    const responseView = await running.client.get(route());
    expect(responseView.status, responseView.text).toBe(200);
    const view = CONSOLE_ROUTES.identity.response.parse(responseView.json);
    expect(view.configured).toBe(true);
    expect(view.profile?.authentication.issuer).toBe("https://siteminder.example.com");
    expect(view.profileDigest).toBe(generateIdentityKit(workspace.air, identity).digest);
    expect(view.files.some((path) => path.startsWith("targets/gemini-enterprise/"))).toBe(true);
    expect(
      (
        await running.client.get(
          "/api/bundles/payments/artifact?path=targets%2Fgemini-enterprise%2Fsetup.json",
        )
      ).status,
    ).toBe(200);
    const response = await running.client.post(
      `/api/bundles/payments/operations/${encodeURIComponent(workspace.air.operations[0]!.id)}/preview`,
      { bundleHash: digest(), input: {} },
    );
    expect(response.status).toBe(422);
    expect(response.json).toMatchObject({ error: { code: "console/identity_required" } });

    const reviewed = { ...identity, id: "ultimatix-reviewed" };
    const validation = CONSOLE_ROUTES.validateIdentity.response.parse(
      (await running.client.post(route("/validate"), { bundleHash: digest(), profile: reviewed }))
        .json,
    );
    expect(validation.ok, JSON.stringify(validation.issues)).toBe(true);
    expect(validation.files).toContain("targets/gemini-enterprise/setup.json");
    const applied = await running.client.post(route(), { bundleHash: digest(), profile: reviewed });
    expect(applied.status, applied.text).toBe(200);
    expect(CONSOLE_ROUTES.applyIdentity.response.parse(applied.json).identity.integrity.state).toBe(
      "fresh",
    );
    const persisted = JSON.parse(
      readFileSync(join(workspace.bundleDir, "targets/gemini-enterprise/setup.json"), "utf8"),
    ).config;
    expect(persisted.identityProfile.id).toBe("ultimatix-reviewed");
    expect(persisted.workforcePool).toBe("locations/global/workforcePools/tcs-entra");
    expect(persisted.connectorOAuth.authorizationUrl).toBe(
      "https://siteminder.example.com/authorize",
    );
  });
});
