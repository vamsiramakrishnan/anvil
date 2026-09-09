import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { airToYaml, operationInputSchema } from "@anvil/air";
import { approveOperationsInBundle, bundleHash, readBundleDir } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSOLE_ROUTES } from "../contract.js";
import { loadAir, paymentsWorkspace, startServer } from "./fixture.js";
import { operationView } from "./read-models.js";
import { previewOperation } from "./workbench.js";

let workspace: Awaited<ReturnType<typeof paymentsWorkspace>>;
let running: Awaited<ReturnType<typeof startServer>>;
let getId: string;

beforeEach(async () => {
  workspace = await paymentsWorkspace();
  running = await startServer(workspace.root);
  const op = workspace.air.operations.find((op) => op.sourceRef.operationId === "getPayment");
  if (!op) throw new Error("Missing fixture read");
  getId = op.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await running?.server.close();
  if (workspace) rmSync(workspace.root, { recursive: true, force: true });
});

const route = (suffix = "") => `/api/bundles/payments${suffix}`;
const previewPath = () => route(`/operations/${getId}/preview`);
const digest = () => bundleHash(readBundleDir(workspace.bundleDir));

describe("workbench", () => {
  it("returns the shared input schema and refuses unapproved execution", async () => {
    const response = await running.client.get(route(`/operations/${getId}`));
    expect(response.status).toBe(200);
    const detail = CONSOLE_ROUTES.operation.response.parse(response.json);
    expect(detail.inputSchema).toEqual(operationInputSchema(detail.operation));
    const before = readBundleDir(workspace.bundleDir);
    const refused = await running.client.post(previewPath(), {
      bundleHash: detail.bundleHash,
      input: { payment_id: "pay_1" },
    });
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ error: { code: "unsupported_operation" } });
    expect(readBundleDir(workspace.bundleDir)).toEqual(before);
  });

  it("plans an approved request without network, credentials, or disk writes", async () => {
    approveOperationsInBundle(workspace.bundleDir, [getId]);
    const before = readBundleDir(workspace.bundleDir);
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network"));
    const result = await previewOperation(workspace.root, "payments", getId, {
      bundleHash: digest(),
      input: { payment_id: "pay_1" },
    });
    expect(result.outcome).toBe("dry_run");
    expect(result.plan.method).toBe("GET");
    expect(result.plan.url).toContain("/payments/pay_1");
    expect(network).not.toHaveBeenCalled();
    expect(readBundleDir(workspace.bundleDir)).toEqual(before);
  });

  it("keeps missing-input and explicit confirmation gates, even in a preview", async () => {
    approveOperationsInBundle(workspace.bundleDir, [getId]);
    const missing = await running.client.post(previewPath(), { bundleHash: digest(), input: {} });
    expect(missing.status).toBe(422);
    expect(missing.json).toMatchObject({ error: { code: "validation_error" } });
    const air = loadAir(workspace.bundleDir);
    const op = air.operations.find((op) => op.id === getId);
    if (!op) throw new Error("Missing read");
    op.confirmation.required = true;
    writeFileSync(join(workspace.bundleDir, "air.yaml"), airToYaml(air));
    const body = { bundleHash: digest(), input: { payment_id: "pay_1" } };
    const refused = await running.client.post(previewPath(), body);
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({
      error: { code: "confirmation_required", issues: ["--confirm"] },
    });
    expect((await running.client.post(previewPath(), { ...body, confirm: true })).status).toBe(200);
  });

  it("rejects stale preview and regeneration requests, and cannot turn off dry-run", async () => {
    const stale = digest();
    approveOperationsInBundle(workspace.bundleDir, [getId]);
    const before = readBundleDir(workspace.bundleDir);
    expect(
      (await running.client.post(previewPath(), { bundleHash: stale, input: {} })).status,
    ).toBe(409);
    expect((await running.client.post(route("/regenerate"), { bundleHash: stale })).status).toBe(
      409,
    );
    expect(
      (await running.client.post(previewPath(), { bundleHash: digest(), input: {}, dryRun: false }))
        .status,
    ).toBe(400);
    expect(readBundleDir(workspace.bundleDir)).toEqual(before);
  });

  it("requires the token and same origin on both new POST routes", async () => {
    for (const path of [previewPath(), route("/regenerate")]) {
      expect((await running.client.post(path, {}, { token: null })).status).toBe(403);
      expect(
        (await running.client.post(path, {}, { origin: "https://untrusted.example" })).status,
      ).toBe(403);
    }
  });

  it("reads evidence and generated artifacts without issuing records; refuses arbitrary files", async () => {
    writeFileSync(join(workspace.bundleDir, "private.txt"), "private-content");
    const before = readBundleDir(workspace.bundleDir);
    const evidence = await running.client.get(route("/evidence"));
    expect(evidence.status).toBe(200);
    const data = CONSOLE_ROUTES.evidence.response.parse(evidence.json);
    expect(data.executable).toHaveLength(3);
    expect(data.executable.every((lane) => lane.state === "missing")).toBe(true);
    const listing = CONSOLE_ROUTES.artifacts.response.parse(
      (await running.client.get(route("/artifacts"))).json,
    );
    expect(listing.files.some((file) => file.path === "skill/SKILL.md")).toBe(true);
    expect(listing.files.some((file) => file.path === "private.txt")).toBe(false);
    const artifact = await running.client.get(route("/artifact?path=skill%2FSKILL.md"));
    expect(artifact.status).toBe(200);
    expect(CONSOLE_ROUTES.artifact.response.parse(artifact.json).content).toBe(
      before["skill/SKILL.md"],
    );
    for (const path of [
      "private.txt",
      "../private.txt",
      "/etc/passwd",
      "constructor",
      "__proto__",
    ]) {
      expect(
        (await running.client.get(route(`/artifact?path=${encodeURIComponent(path)}`))).status,
      ).toBe(404);
    }
    expect(readBundleDir(workspace.bundleDir)).toEqual(before);
  });

  it("bounds artifact previews and refuses symlink-backed content", async () => {
    writeFileSync(join(workspace.bundleDir, "skill", "SKILL.md"), "x".repeat(256 * 1024 + 1));
    const large = await running.client.get(route("/artifact?path=skill%2FSKILL.md"));
    expect(large.status).toBe(200);
    const preview = CONSOLE_ROUTES.artifact.response.parse(large.json);
    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(preview.content)).toBe(256 * 1024);
    const target = join(workspace.root, "outside.txt");
    writeFileSync(target, "outside-content");
    rmSync(join(workspace.bundleDir, "skill", "SKILL.md"));
    symlinkSync(target, join(workspace.bundleDir, "skill", "SKILL.md"));
    const reply = await running.client.get(route("/artifact?path=skill%2FSKILL.md"));
    expect(reply.status).toBe(409);
    expect(reply.text).not.toContain("outside-content");
  });

  it("regenerates all projections from current AIR without approving anything", async () => {
    const air = loadAir(workspace.bundleDir);
    const states = air.operations.map((op) => op.state);
    const op = air.operations[0];
    if (!op) throw new Error("No operations");
    op.description = "A reviewed description applied to AIR.";
    writeFileSync(join(workspace.bundleDir, "air.yaml"), airToYaml(air));
    const result = await running.client.post(route("/regenerate"), { bundleHash: digest() });
    expect(result.status).toBe(200);
    expect(CONSOLE_ROUTES.regenerate.response.parse(result.json).projectionsChanged).toBe(true);
    const projected = JSON.parse(
      readFileSync(join(workspace.bundleDir, "mcp", "air.json"), "utf8"),
    );
    expect(projected.operations[0].description).toBe(op.description);
    expect(loadAir(workspace.bundleDir).operations.map((op) => op.state)).toEqual(states);
  });

  it("isolates corrupt bundles so the remaining workspace stays usable", async () => {
    mkdirSync(join(workspace.root, "broken"));
    writeFileSync(join(workspace.root, "broken", "air.yaml"), "not: a bundle");
    const response = await running.client.get("/api/workspace");
    expect(response.status).toBe(200);
    const workspaceView = CONSOLE_ROUTES.workspace.response.parse(response.json);
    expect(workspaceView.bundles.map((b) => b.id)).toContain("payments");
    expect(workspaceView.issues.map((b) => b.id)).toEqual(["broken"]);
    expect(operationView(workspace.root, "payments", getId).operation.id).toBe(getId);
  });
});
