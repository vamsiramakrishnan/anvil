import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CONSOLE_ROUTES } from "../contract.js";
import { type Client, startServer } from "./fixture.js";

let root: string, client: Client, close: () => Promise<void>;
const project = JSON.parse(
  readFileSync(new URL("../../../../examples/business/project.json", import.meta.url), "utf8"),
);
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "anvil-business-console-"));
  const result = await startServer(root);
  client = result.client;
  close = () => result.server.close();
});
afterEach(async () => {
  await close();
  rmSync(root, { recursive: true, force: true });
});
it("protects project authoring, validates snapshots, and compiles the exact saved revision", async () => {
  expect(
    (
      await client.post(
        "/api/business/projects",
        { project, expectedDigest: null },
        { token: null },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await client.post(
        "/api/business/projects",
        { project, expectedDigest: null },
        { origin: "https://attacker.invalid" },
      )
    ).status,
  ).toBe(403);
  const preview = await client.post("/api/business/projects/preview", { project });
  expect(preview.status, preview.text).toBe(200);
  const saved = await client.post("/api/business/projects", { project, expectedDigest: null });
  expect(saved.status, saved.text).toBe(200);
  const revision = CONSOLE_ROUTES.saveBusinessProject.response.parse(saved.json);
  expect(revision.project.definition.actions.every((a) => a.state === "proposed")).toBe(true);
  const duplicate = await client.post("/api/business/projects", { project, expectedDigest: null });
  expect(duplicate.status).toBe(400);
  const built = await client.post(`/api/business/projects/${project.definition.id}/build`, {
    expectedDigest: revision.digest,
  });
  expect(built.status, built.text).toBe(200);
  const result = CONSOLE_ROUTES.buildBusinessProject.response.parse(built.json);
  expect(
    JSON.parse(readFileSync(join(root, result.bundleId, "air.json"), "utf8")).operations.every(
      (o: { state: string }) => o.state !== "approved",
    ),
  ).toBe(true);
  const evaluated = await client.post(`/api/business/projects/${project.definition.id}/evaluate`, {
    expectedDigest: revision.digest,
    repeats: 3,
  });
  expect(evaluated.status).toBe(400);
});
it("refuses a private binding to an unapproved source operation", async () => {
  const invalid = structuredClone(project);
  invalid.sources.orders.operations.forEach((op: { state: string }) => {
    op.state = "review_required";
  });
  expect(
    (await client.post("/api/business/projects", { project: invalid, expectedDigest: null }))
      .status,
  ).toBe(400);
});
