import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { identityProfileJsonSchema } from "@anvil/air";
import { expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

it("generates a reusable identity kit through the public CLI without altering AIR", async () => {
  const root = mkdtempSync(join(tmpdir(), "anvil-identity-"));
  try {
    const bundle = join(root, "bundle");
    const io = bufferIO();
    expect(
      await runAnvilCli(
        [
          "compile",
          fileURLToPath(new URL("../../../examples/payments/openapi.yaml", import.meta.url)),
          "--out",
          bundle,
          "--root",
          root,
        ],
        { io },
      ),
    ).toBe(0);
    const airPath = join(bundle, "air.json");
    const before = readFileSync(airPath, "utf8");
    const air = JSON.parse(before);
    const profile = {
      version: 1,
      id: "enterprise",
      authentication: {
        provider: "oidc",
        issuer: "https://id.example",
        audience: "https://mcp.example",
        jwksUri: "https://id.example/keys",
      },
      mapping: {
        tenant: { source: "fixed", value: "enterprise" },
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
    const path = join(root, "profile.json");
    writeFileSync(path, JSON.stringify(profile));
    expect(await runAnvilCli(["target", "identity", bundle, "--profile", path], { io })).toBe(0);
    const bindingPath = join(bundle, "targets/identity/binding.json");
    const binding = readFileSync(bindingPath, "utf8");
    expect(JSON.parse(binding)).toMatchObject({ profile: "enterprise", verifiedLive: false });
    expect(readFileSync(airPath, "utf8")).toBe(before);
    const statusIO = bufferIO();
    await runAnvilCli(["status", bundle, "--json"], { io: statusIO });
    const status = JSON.parse(statusIO.stdout.join("\n"));
    expect(status.targets).toEqual(
      expect.arrayContaining([expect.objectContaining({ targetId: "identity", state: "fresh" })]),
    );

    profile.authorization.rules[0]!.operations = ["unknown-operation"];
    writeFileSync(path, JSON.stringify(profile));
    expect(await runAnvilCli(["target", "identity", bundle, "--profile", path], { io })).toBe(1);
    expect(readFileSync(bindingPath, "utf8")).toBe(binding);
    const schemaPath = join(root, "schema.json");
    expect(await runAnvilCli(["schema", "identity", "--out", schemaPath], { io })).toBe(0);
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(identityProfileJsonSchema());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
