import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import { CAPABILITIES } from "./capabilities.js";
import { bufferIO } from "./io.js";

/**
 * `anvil deploy gateway` (Anvil contract v2, item 5) writes configuration only:
 * the Dockerfile entrypoint, probes, branchyard inbound-auth env, ledger and
 * drain window. These tests read the generated files; no Cloud Run is touched.
 * `anvil capabilities` lists the features this tree implements.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function cli(args: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(args, { io });
  return { code, io };
}

const FLAGS = [
  "--image",
  "europe-docker.pkg.dev/proj/anvil/gateway:1",
  "--project",
  "proj",
  "--public-url",
  "https://gateway.example.com",
  "--branchyard-url",
  "https://branchyard.example.com",
];

describe("anvil deploy gateway", () => {
  it("writes a Dockerfile and a Cloud Run service with probes, branchyard auth, ledger and drain", async () => {
    const out = mkdtempSync(join(tmpdir(), "anvil-deploy-gateway-"));
    roots.push(out);
    const run = await cli(["deploy", "gateway", "--out", out, ...FLAGS]);
    expect(run.code, run.io.text()).toBe(0);
    const dockerfile = readFileSync(join(out, "deploy/gateway/Dockerfile"), "utf8");
    expect(dockerfile).toContain("serve mcp /srv/bundles --fleet --http");
    expect(dockerfile).toContain('\\"$PORT\\"');
    expect(dockerfile).toContain("--host 0.0.0.0");
    expect(dockerfile).toContain("exec node");
    expect(dockerfile).toContain("USER node");

    const service = parse(readFileSync(join(out, "deploy/gateway/service.yaml"), "utf8"));
    const container = service.spec.template.spec.containers[0];
    expect(container.image).toBe("europe-docker.pkg.dev/proj/anvil/gateway:1");
    expect(container.startupProbe.httpGet).toEqual({ path: "/readyz", port: 8080 });
    expect(container.livenessProbe.httpGet).toEqual({ path: "/healthz", port: 8080 });
    const env = Object.fromEntries(
      (container.env as Array<{ name: string; value: string }>).map((e) => [e.name, e.value]),
    );
    expect(env).toMatchObject({
      ANVIL_INBOUND_AUTH_MODE: "branchyard",
      ANVIL_INBOUND_ISSUER: "https://branchyard.example.com",
      ANVIL_INBOUND_AUDIENCE: "https://gateway.example.com/mcp",
      ANVIL_INBOUND_JWKS_URI: "https://branchyard.example.com/.well-known/jwks.json",
      ANVIL_GATEWAY_PUBLIC_URL: "https://gateway.example.com",
      ANVIL_LEDGER: "firestore://proj/(default)/gateway",
      ANVIL_SHUTDOWN_GRACE_SECONDS: "8",
      ANVIL_ENV: "prod",
    });
    // A secret value never rides in the service definition: the vault key is a mounted secret.
    expect(env.ANVIL_VAULT_KEY_FILE).toBe("/secrets/vault/key");
    expect(JSON.stringify(service)).not.toMatch(/token|password/i);
    // Under Cloud Run's 10-second SIGTERM window.
    expect(Number(env.ANVIL_SHUTDOWN_GRACE_SECONDS)).toBeLessThan(10);
  });

  it("takes a JWKS override and a ledger namespace, and refuses http and malformed inputs", async () => {
    const out = mkdtempSync(join(tmpdir(), "anvil-deploy-gateway-"));
    roots.push(out);
    const ok = await cli([
      "deploy",
      "gateway",
      "--out",
      out,
      ...FLAGS,
      "--jwks-uri",
      "https://keys.example.com/jwks.json",
      "--ledger-namespace",
      "tools",
    ]);
    expect(ok.code, ok.io.text()).toBe(0);
    const text = readFileSync(join(out, "deploy/gateway/service.yaml"), "utf8");
    expect(text).toContain("https://keys.example.com/jwks.json");
    expect(text).toContain("firestore://proj/(default)/tools");

    const swap = (flag: string, value: string) => {
      const args = [...FLAGS];
      args[args.indexOf(flag) + 1] = value;
      return args;
    };
    for (const [flag, value] of [
      ["--public-url", "http://gateway.example.com"],
      ["--branchyard-url", "not a url"],
      ["--project", "bad project"],
      ["--image", "has space"],
    ] as const) {
      const bad = await cli(["deploy", "gateway", "--out", out, ...swap(flag, value)]);
      expect(bad.code).toBe(1);
      expect(bad.io.stderr.join("\n")).toContain("anvil deploy gateway:");
    }
  });
});

describe("anvil capabilities", () => {
  it("prints the features this tree implements as JSON", async () => {
    const run = await cli(["capabilities", "--json"]);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.io.stdout.join("").trim()) as { features: string[] };
    expect(parsed.features).toEqual([...CAPABILITIES].sort());
    expect(parsed.features).toEqual(expect.arrayContaining(["token.proxy", "manifest.claim"]));
    // Only names the contract defines.
    const contract = [
      "vault.firestore",
      "connect.disconnect",
      "package.search",
      "skill.lean",
      "install.prefix",
      "package.oci",
      "token.proxy",
      "manifest.claim",
      "bundle.icon",
    ];
    for (const feature of parsed.features) expect(contract).toContain(feature);
  });
});
