import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleHash, certifyBundle, loadBundleAir, readBundleDir } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONSOLE_ROUTES, zErrorEnvelope } from "../contract.js";
import { type Client, startServer } from "./fixture.js";

const exampleRoot = fileURLToPath(new URL("../../../../examples/payments/", import.meta.url));
const spec = readFileSync(join(exampleRoot, "openapi.yaml"), "utf8");
let root: string;
let client: Client;
let close: () => Promise<void>;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "anvil-workbench-"));
  const started = await startServer(root);
  client = started.client;
  close = () => started.server.close();
});
afterEach(async () => {
  await close();
  rmSync(root, { recursive: true, force: true });
});
const upload = (name = "payments") => ({
  name,
  input: {
    kind: "upload",
    entrypoint: "openapi.yaml",
    files: [{ path: "openapi.yaml", content: spec }],
  },
});
async function create(name = "payments") {
  const reply = await client.post("/api/bundles", upload(name));
  expect(reply.status, reply.text).toBe(200);
  return CONSOLE_ROUTES.createBundle.response.parse(reply.json);
}
const url = (id: string, view: string) => `/api/bundles/${encodeURIComponent(id)}/${view}`;

describe("create bundles through locked source snapshots", () => {
  it("compiles an upload, keeps source bytes, exposes it in the workspace, and preserves review gates", async () => {
    const created = await create();
    const dir = join(root, created.id);
    const files = readBundleDir(dir);
    const air = loadBundleAir(dir, files);
    expect(created.id).toBe("generated/payments");
    expect(created.generatedFiles).toBeGreaterThan(30);
    expect(air.service.source.snapshotId).toBe(created.snapshotId);
    expect(
      readFileSync(join(root, ".anvil/sources", created.snapshotId, "raw/openapi.yaml"), "utf8"),
    ).toBe(spec);
    expect(
      air.operations
        .filter((op) => op.effect.kind === "mutation" && op.idempotency.mode === "none")
        .every((op) => op.state === "review_required"),
    ).toBe(true);
    expect(JSON.parse(files["mcp/air.json"] ?? "{}").operations).toEqual(
      JSON.parse(files["air.json"] ?? "{}").operations,
    );
    expect(
      CONSOLE_ROUTES.workspace.response
        .parse((await client.get("/api/workspace")).json)
        .bundles.map((b) => b.id),
    ).toContain(created.id);
    expect(readdirSync(join(root, ".anvil/console/uploads"))).toEqual([]);
  });

  it("preserves nested entrypoint references across uploaded directories", async () => {
    const reply = await client.post("/api/bundles", {
      name: "nested",
      input: {
        kind: "upload",
        entrypoint: "api/openapi.yaml",
        files: [
          {
            path: "api/openapi.yaml",
            content:
              "openapi: 3.0.3\ninfo: {title: Nested, version: '1.0'}\npaths:\n  /items:\n    get:\n      operationId: listItems\n      responses:\n        '200':\n          description: Items\n          content:\n            application/json:\n              schema:\n                $ref: '../models/item.yaml'\n",
          },
          {
            path: "models/item.yaml",
            content: "type: object\nproperties:\n  id: {type: string}\n",
          },
        ],
      },
    });
    expect(reply.status, reply.text).toBe(200);
    const created = CONSOLE_ROUTES.createBundle.response.parse(reply.json);
    expect(
      readFileSync(
        join(root, ".anvil/sources", created.snapshotId, "raw/models/item.yaml"),
        "utf8",
      ),
    ).toContain("id:");
    expect(created.diagnostics.filter((d) => d.level === "error")).toEqual([]);
  });

  it.each([
    [
      "graphql",
      "schema.graphql",
      "type Query { customer(id: ID!): Customer }\ntype Customer { id: ID! name: String }",
    ],
    [
      "grpc",
      "service.proto",
      'syntax = "proto3"; package orders; service Orders { rpc GetOrder (Request) returns (Order); } message Request { string id = 1; } message Order { string id = 1; }',
    ],
    ["har", "capture.har", readFileSync(join(exampleRoot, "capture.har"), "utf8")],
    [
      "odata",
      "metadata.edmx",
      '<?xml version="1.0"?><edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"><edmx:DataServices><Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Demo"><EntityType Name="Product"><Key><PropertyRef Name="Id" /></Key><Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType><EntityContainer Name="Default"><EntitySet Name="Products" EntityType="Demo.Product" /></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>',
    ],
  ])("compiles %s files through directory import", async (name, path, content) => {
    const reply = await client.post("/api/bundles", {
      name,
      input: { kind: "upload", entrypoint: path, files: [{ path, content }] },
    });
    expect(reply.status, reply.text).toBe(200);
    expect(CONSOLE_ROUTES.createBundle.response.parse(reply.json).operations).toBeGreaterThan(0);
  });

  it("compiles an existing workspace path without an upload", async () => {
    mkdirSync(join(root, "specs"));
    writeFileSync(join(root, "specs/openapi.yaml"), spec);
    const reply = await client.post("/api/bundles", {
      name: "local",
      input: { kind: "workspace", path: "specs/openapi.yaml" },
    });
    expect(reply.status, reply.text).toBe(200);
    expect(existsSync(join(root, "generated/local/cli/local.mjs"))).toBe(true);
  });

  it("never overwrites a bundle on repeat or simultaneous creation", async () => {
    const replies = await Promise.all([
      client.post("/api/bundles", upload()),
      client.post("/api/bundles", upload()),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(zErrorEnvelope.parse(replies.find((r) => r.status === 409)?.json).error.code).toBe(
      "console/destination_exists",
    );
    const before = readBundleDir(join(root, "generated/payments"));
    expect((await client.post("/api/bundles", upload())).status).toBe(409);
    expect(readBundleDir(join(root, "generated/payments"))).toEqual(before);
  });

  it("refuses invalid sources without leaving a partial destination", async () => {
    const request = upload("invalid");
    request.input.files[0]!.content = "not an API";
    expect((await client.post("/api/bundles", request)).status).toBe(400);
    expect(existsSync(join(root, "generated/invalid"))).toBe(false);
    expect(readdirSync(join(root, ".anvil/console/uploads"))).toEqual([]);
  });

  it("enforces token, origin, source paths, duplicate paths, and destination containment", async () => {
    for (const opts of [{ token: null }, { origin: "https://example.test" }])
      expect((await client.post("/api/bundles", upload(), opts)).status).toBe(403);
    for (const path of [
      "../escape.yaml",
      "/escape.yaml",
      "a/../../escape.yaml",
      "a\\escape.yaml",
      ".env",
    ]) {
      const reply = await client.post("/api/bundles", {
        name: "bad",
        input: { kind: "upload", entrypoint: path, files: [{ path, content: spec }] },
      });
      expect(reply.status, path).toBe(400);
    }
    expect(
      (await client.post("/api/bundles", { name: "../escape", input: upload().input })).status,
    ).toBe(400);
    expect(
      (
        await client.post("/api/bundles", {
          name: "outside",
          input: { kind: "workspace", path: "../outside.yaml" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.post("/api/bundles", {
          name: "duplicate",
          input: { ...upload().input, files: [...upload().input.files, ...upload().input.files] },
        })
      ).status,
    ).toBe(400);
    const outside = mkdtempSync(join(tmpdir(), "anvil-outside-"));
    try {
      symlinkSync(outside, join(root, "generated"));
      const reply = await client.post("/api/bundles", upload());
      expect(reply.status).toBe(400);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("evidence and generated files", () => {
  it("reads current checks and detects stale executable evidence without writing", async () => {
    const created = await create();
    const dir = join(root, created.id);
    const files = readBundleDir(dir);
    const air = loadBundleAir(dir, files);
    const hash = bundleHash(files);
    writeFileSync(join(dir, "certification.json"), JSON.stringify(certifyBundle(files, air)));
    writeFileSync(
      join(dir, "selftest.report.json"),
      JSON.stringify({
        schemaVersion: 1,
        bundleHash: hash,
        summary: { pass: 5, fail: 0, skipped: 0 },
      }),
    );
    const before = readBundleDir(dir);
    const reply = await client.get(url(created.id, "evidence"));
    expect(reply.status, reply.text).toBe(200);
    const evidence = CONSOLE_ROUTES.evidence.response.parse(reply.json);
    expect(evidence.bundleHash).toBe(hash);
    expect(evidence.staticChecks.length).toBeGreaterThan(0);
    expect(evidence.executable.find((e) => e.lane === "selftest")?.state).toBe("fresh");
    expect(readBundleDir(dir)).toEqual(before);
    writeFileSync(join(dir, "cli/payments.mjs"), `${files["cli/payments.mjs"]}\n// changed\n`);
    const stale = CONSOLE_ROUTES.evidence.response.parse(
      (await client.get(url(created.id, "evidence"))).json,
    );
    expect(stale.executable.find((e) => e.lane === "selftest")?.state).toBe("stale");
    expect(stale.certification.valid).toBe(false);
  });

  it("lists and reads generated artifacts while refusing escapes and oversized previews", async () => {
    const created = await create();
    const dir = join(root, created.id);
    writeFileSync(join(dir, ".env"), "PASSWORD=private");
    writeFileSync(join(dir, "operator-notes.txt"), "private note");
    const inventory = CONSOLE_ROUTES.artifacts.response.parse(
      (await client.get(url(created.id, "artifacts"))).json,
    );
    expect(inventory.files.map((f) => f.path)).toContain("mcp/server.js");
    expect(inventory.files.map((f) => f.path)).not.toContain(".env");
    expect(inventory.files.map((f) => f.path)).not.toContain("operator-notes.txt");
    const file = CONSOLE_ROUTES.artifact.response.parse(
      (await client.get(`${url(created.id, "artifact")}?path=cli%2Fpayments.mjs`)).json,
    );
    expect(file.content).toBe(readFileSync(join(dir, "cli/payments.mjs"), "utf8"));
    for (const path of ["../air.yaml", ".env", "operator-notes.txt", "mcp/../../outside"])
      expect(
        (await client.get(`${url(created.id, "artifact")}?path=${encodeURIComponent(path)}`))
          .status,
      ).toBe(404);
    writeFileSync(join(dir, "mcp/large.json"), "x".repeat(1024 * 1024 + 1));
    const large = await client.get(`${url(created.id, "artifact")}?path=mcp%2Flarge.json`);
    expect(large.status).toBe(404);
    expect(zErrorEnvelope.parse(large.json).error.code).toBe("console/not_found");
    writeFileSync(join(dir, "mcp/server.js"), "x".repeat(1024 * 1024 + 1));
    const preview = CONSOLE_ROUTES.artifact.response.parse(
      (await client.get(`${url(created.id, "artifact")}?path=mcp%2Fserver.js`)).json,
    );
    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(preview.content)).toBe(256 * 1024);
  });

  it("keeps healthy bundles visible when another bundle is corrupt", async () => {
    const created = await create();
    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "broken/air.yaml"), "broken: true");
    const workspace = CONSOLE_ROUTES.workspace.response.parse(
      (await client.get("/api/workspace")).json,
    );
    expect(workspace.bundles.map((b) => b.id)).toEqual([created.id]);
    expect(workspace.issues?.map((issue) => issue.id)).toEqual(["broken"]);
  });
});
