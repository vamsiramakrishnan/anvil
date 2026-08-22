import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

/**
 * `anvil sdk` — the operator's view of the fourth surface.
 *
 * What this guards is not formatting. It is that an operator can see, without
 * opening four generated trees, which operations became methods, what each is
 * called in each language, and which gates a call has to satisfy — and that an
 * unapproved operation appears in none of it.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SPEC = `openapi: 3.0.3
info: { title: Billing, version: 1.0.0 }
servers:
  - url: https://billing.example.com
paths:
  /invoices/{invoice_id}:
    get:
      operationId: getInvoice
      tags: [invoices]
      parameters:
        - { name: invoice_id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
  /invoices/{invoice_id}/void:
    post:
      operationId: voidInvoice
      tags: [invoices]
      parameters:
        - { name: invoice_id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`;

/**
 * A compiled bundle with the read approved and the mutation left alone.
 *
 * `voidInvoice` is a POST with unproven idempotency, so it stays
 * `review_required` — which is exactly the case worth asserting: the SDK must
 * not name it.
 */
async function bundle(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "anvil-cmd-sdk-"));
  roots.push(root);
  const spec = join(root, "billing.yaml");
  writeFileSync(spec, SPEC, "utf8");
  const out = join(root, "bundle");
  const io = bufferIO();
  const code = await runAnvilCli(["compile", spec, "--out", out, "--service", "billing"], { io });
  expect(code, io.text()).toBe(0);
  const approveIo = bufferIO();
  const approved = await runAnvilCli(["approve", out, "billing.invoices.get"], {
    io: approveIo,
  });
  expect(approved, approveIo.text()).toBe(0);
  return out;
}

async function run(argv: string[]): Promise<{ code: number; text: string; stdout: string }> {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, text: io.text(), stdout: io.stdout.join("\n") };
}

describe("anvil sdk", () => {
  it("names each approved operation's method in all four languages", async () => {
    const result = await run(["sdk", await bundle()]);
    expect(result.code, result.text).toBe(0);
    expect(result.stdout).toContain("billing.invoices.get");
    expect(result.stdout).toContain("typescript: getInvoice");
    expect(result.stdout).toContain("python: get_invoice");
    expect(result.stdout).toContain("go: GetInvoice");
    expect(result.stdout).toContain("java: getInvoice");
  });

  it("says where the credential comes from and where it goes", async () => {
    const result = await run(["sdk", await bundle()]);
    expect(result.stdout).toContain("https://billing.example.com");
    expect(result.stdout).toMatch(/Credential/);
  });

  it("never lists an operation that has not been approved", async () => {
    // An SDK listing that showed it would be advertising a method no language
    // actually emits.
    const dir = await bundle();
    const result = await run(["sdk", dir]);
    expect(result.stdout).not.toContain("billing.invoices.void");
    expect(result.stdout).not.toContain("voidInvoice");
  });

  it("re-emits the trees under --out without dragging the bundle along", async () => {
    const dir = await bundle();
    const out = join(dir, "..", "clients");
    const result = await run(["sdk", dir, "--out", out]);
    expect(result.code, result.text).toBe(0);
    for (const rel of [
      "manifest.json",
      "typescript/package.json",
      "python/pyproject.toml",
      "go/go.mod",
      "java/pom.xml",
    ]) {
      expect(existsSync(join(out, rel)), rel).toBe(true);
    }
    // The bytes are the bundle's, not a second projection that could differ.
    expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe(
      readFileSync(join(dir, "sdk/manifest.json"), "utf8"),
    );
  });

  it("narrows to the requested languages and leaves the rest unwritten", async () => {
    const dir = await bundle();
    const out = join(dir, "..", "go-only");
    expect((await run(["sdk", dir, "--out", out, "--lang", "go"])).code).toBe(0);
    expect(existsSync(join(out, "go/go.mod"))).toBe(true);
    expect(existsSync(join(out, "java/pom.xml"))).toBe(false);
    // The shared index still travels: it describes the whole set either way.
    expect(existsSync(join(out, "manifest.json"))).toBe(true);
  });

  it("refuses an unknown language instead of silently emitting nothing", async () => {
    const result = await run(["sdk", await bundle(), "--lang", "rust,go"]);
    expect(result.code).toBe(1);
    expect(result.text).toContain("sdk_language_unknown");
    expect(result.text).toContain("rust");
  });
});
