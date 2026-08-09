import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, airToJson, loadAirDocument } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

/**
 * Drift-guard for `anvil inspect` (implementation plan Phase 6): proves an
 * operator reading CLI output alone can tell apart a webhook-backed
 * completion, an unchanged pure-poll completion, a broken contract
 * (`no_completion_source`), and an upstream pending-approval state
 * (`awaiting_human_input`) — side by side, one fixture, exact-string
 * comparison per CLAUDE.md's drift-guard convention.
 *
 * The pure-poll case doubles as the re-confirmation the plan's task 1 asks
 * for: `asyncContractSentence()`'s wording for a plain poll contract must be
 * byte-identical to what a pre-Phase-0 pure-poll contract produced — no
 * webhook wording, no `no_completion_source` wording, leaking in.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureAir(): AirDocument {
  return loadAirDocument({
    service: {
      id: "asyncdemo",
      displayName: "Async Demo",
      version: "1",
      source: { kind: "openapi" },
      servers: [{ url: "https://asyncdemo.example.com" }],
    },
    operations: [
      // 1. Webhook-only completion: no poll operation exists at all.
      {
        id: "asyncdemo.webhookonly.create",
        canonicalName: "create_webhook_job",
        displayName: "Create webhook job",
        description: "Starts a job completed via webhook only.",
        sourceRef: { kind: "openapi", path: "/webhookonly", method: "post" },
        effect: { kind: "mutation", action: "create", resource: "webhook_job", risk: "low" },
        input: { params: [] },
        longRunning: true,
        archetype: "long_running",
        asyncContract: {
          jobIdField: "job.id",
          terminalStates: ["succeeded", "failed"],
          pendingStates: [],
          webhook: {
            webhookOperationId: "asyncdemo.webhookonly.webhook",
            webhookJobIdField: "data.id",
            webhookStateField: "data.status",
            signatureVerification: {
              scheme: "hmac_sha256_header",
              headerName: "X-Signature",
              encoding: "hex",
              secretRef: "WEBHOOKONLY_SECRET",
            },
          },
        },
        idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "none", scopes: [] },
        cli: { command: "asyncdemo webhookonly create" },
        mcp: { toolName: "asyncdemo_create_webhook_job" },
        skill: { intentExamples: [] },
        state: "approved",
      },
      {
        id: "asyncdemo.webhookonly.webhook",
        canonicalName: "webhookonly_webhook",
        displayName: "Webhook-only receiver",
        description: "Inbound completion for the webhook-only job.",
        sourceRef: { kind: "openapi", path: "/webhooks/webhookonly", method: "post" },
        effect: { kind: "read", action: "get", resource: "webhookonly_webhook", risk: "none" },
        input: { params: [] },
        idempotency: { mode: "none", mechanism: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "none", scopes: [] },
        cli: { command: "asyncdemo webhookonly webhook" },
        mcp: { toolName: "asyncdemo_webhookonly_webhook" },
        skill: { intentExamples: [] },
        state: "approved",
        archetype: "webhook_receiver",
      },
      // 2. Pure poll, control case: must print exactly as it did before Phase 6.
      {
        id: "asyncdemo.pollonly.create",
        canonicalName: "create_poll_job",
        displayName: "Create poll job",
        description: "Starts a job completed via polling only.",
        sourceRef: { kind: "openapi", path: "/pollonly", method: "post" },
        effect: { kind: "mutation", action: "create", resource: "poll_job", risk: "low" },
        input: { params: [] },
        longRunning: true,
        archetype: "long_running",
        asyncContract: {
          statusOperationId: "asyncdemo.pollonly.get",
          jobIdField: "job.id",
          statusJobIdParam: "job_id",
          stateField: "job.state",
          terminalStates: ["succeeded", "failed"],
          pendingStates: ["queued", "running"],
        },
        idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "none", scopes: [] },
        cli: { command: "asyncdemo pollonly create" },
        mcp: { toolName: "asyncdemo_create_poll_job" },
        skill: { intentExamples: [] },
        state: "approved",
      },
      {
        id: "asyncdemo.pollonly.get",
        canonicalName: "get_poll_job",
        displayName: "Get poll job",
        description: "Reads a poll-only job.",
        sourceRef: { kind: "openapi", path: "/pollonly/{job_id}", method: "get" },
        effect: { kind: "read", action: "get", resource: "poll_job", risk: "low" },
        input: { params: [{ name: "job_id", in: "path", required: true }] },
        idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
        retries: {
          mode: "safe",
          basis: "read_safe",
          maxAttempts: 3,
          backoff: "exponential_jitter",
        },
        confirmation: { required: false },
        auth: { type: "none", scopes: [] },
        cli: { command: "asyncdemo pollonly get" },
        mcp: { toolName: "asyncdemo_get_poll_job" },
        skill: { intentExamples: [] },
        state: "approved",
      },
      // 3. Upstream pending-approval: pendingStates includes awaiting_human_input.
      {
        id: "asyncdemo.approval.create",
        canonicalName: "create_approval_job",
        displayName: "Create approval job",
        description: "Starts a job that may sit awaiting a human decision upstream.",
        sourceRef: { kind: "openapi", path: "/approval", method: "post" },
        effect: { kind: "mutation", action: "create", resource: "approval_job", risk: "medium" },
        input: { params: [] },
        longRunning: true,
        archetype: "long_running",
        asyncContract: {
          statusOperationId: "asyncdemo.approval.get",
          jobIdField: "job.id",
          statusJobIdParam: "job_id",
          stateField: "job.state",
          terminalStates: ["approved_final", "rejected_final"],
          pendingStates: ["awaiting_human_input"],
        },
        idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "none", scopes: [] },
        cli: { command: "asyncdemo approval create" },
        mcp: { toolName: "asyncdemo_create_approval_job" },
        skill: { intentExamples: [] },
        state: "approved",
      },
      {
        id: "asyncdemo.approval.get",
        canonicalName: "get_approval_job",
        displayName: "Get approval job",
        description: "Reads an approval job's state.",
        sourceRef: { kind: "openapi", path: "/approval/{job_id}", method: "get" },
        effect: { kind: "read", action: "get", resource: "approval_job", risk: "low" },
        input: { params: [{ name: "job_id", in: "path", required: true }] },
        idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
        retries: {
          mode: "safe",
          basis: "read_safe",
          maxAttempts: 3,
          backoff: "exponential_jitter",
        },
        confirmation: { required: false },
        auth: { type: "none", scopes: [] },
        cli: { command: "asyncdemo approval get" },
        mcp: { toolName: "asyncdemo_get_approval_job" },
        skill: { intentExamples: [] },
        state: "approved",
      },
      // 4. Broken contract: neither a status operation nor a webhook.
      {
        id: "asyncdemo.broken.create",
        canonicalName: "create_broken_job",
        displayName: "Create broken job",
        description: "Declares async completion but names neither a poll nor a webhook.",
        sourceRef: { kind: "openapi", path: "/broken", method: "post" },
        effect: { kind: "mutation", action: "create", resource: "broken_job", risk: "low" },
        input: { params: [] },
        longRunning: true,
        archetype: "long_running",
        asyncContract: {
          jobIdField: "job.id",
          terminalStates: ["done"],
          pendingStates: [],
        },
        idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "none", scopes: [] },
        cli: { command: "asyncdemo broken create" },
        mcp: { toolName: "asyncdemo_create_broken_job" },
        skill: { intentExamples: [] },
        state: "approved",
      },
    ],
  });
}

function writeFixtureAir(): string {
  const root = mkdtempSync(join(tmpdir(), "anvil-inspect-"));
  roots.push(root);
  const path = join(root, "air.json");
  writeFileSync(path, airToJson(fixtureAir()));
  return path;
}

describe("anvil inspect: async completion surfacing", () => {
  it("prints the webhook path, unchanged pure-poll, pending-approval, and broken-contract cases side by side", async () => {
    const path = writeFixtureAir();
    const io = bufferIO();
    const code = await runAnvilCli(["inspect", path], { io });
    expect(code).toBe(0);
    const text = io.text();

    // 1. Webhook-only: no poll operation, so the webhook line says so.
    expect(text).toContain("Create webhook job · approved · id=asyncdemo.webhookonly.create");
    expect(text).toContain(
      "    webhook       via 'asyncdemo.webhookonly.webhook' · job id 'data.id' · verified hmac_sha256_header · no poll operation — webhook only",
    );

    // The webhook receiver operation itself gets its own catalog/inspect entry
    // too, but never a webhook/pending/issue line of its own — it has no
    // asyncContract, it IS one.
    expect(text).toContain("Webhook-only receiver · approved · id=asyncdemo.webhookonly.webhook");

    // 2. Pure poll (control): the exact pre-Phase-6 block, verbatim — no
    // webhook, async issue, or pending line anywhere near it.
    const pollBlock = blockFor(text, "asyncdemo.pollonly.create");
    expect(pollBlock).toEqual(
      [
        "  Create poll job · approved · id=asyncdemo.pollonly.create",
        "    command       asyncdemo pollonly create",
        `    try safely    anvil run '${path}' pollonly create --dry-run`,
        "    effect        mutation · low risk · reversible",
        "    safeguards    confirm not required · idempotency natural · retry not automatic",
        "    access        none · service principal · scopes none declared",
      ].join("\n"),
    );

    // 3. Awaiting human approval: flagged, distinct from an ordinary pending state.
    expect(text).toContain("Create approval job · approved · id=asyncdemo.approval.create");
    expect(text).toContain(
      "    pending       awaiting_human_input — may sit waiting on a human decision; answer with `anvil job answer`",
    );

    // 4. Broken contract: the generic AsyncContractIssue, not special-cased text.
    expect(text).toContain("Create broken job · approved · id=asyncdemo.broken.create");
    expect(text).toContain(
      "    async issue   no_completion_source — asyncdemo.broken.create declares neither a status operation nor a webhook to complete on",
    );

    // No cross-contamination: the poll-only and approval blocks never grow a
    // `webhook`/`async issue`/`pending` line, and the webhook-only block never
    // grows an `async issue`/`pending` line of its own.
    expect(blockFor(text, "asyncdemo.pollonly.create")).not.toMatch(
      /^ {4}(webhook|async issue|pending) /m,
    );
    expect(blockFor(text, "asyncdemo.approval.create")).not.toMatch(/^ {4}(webhook|async issue) /m);
    expect(blockFor(text, "asyncdemo.webhookonly.create")).not.toMatch(
      /^ {4}(async issue|pending) /m,
    );
    expect(blockFor(text, "asyncdemo.broken.create")).not.toMatch(/^ {4}(webhook|pending) /m);
  });

  it("carries the same information on the --json path", async () => {
    const path = writeFixtureAir();
    const io = bufferIO();
    const code = await runAnvilCli(["inspect", path, "--json"], { io });
    expect(code).toBe(0);
    const catalog = JSON.parse(io.text());
    const byId = new Map((catalog.operations as Array<{ id: string }>).map((op) => [op.id, op]));

    const webhookOnly = byId.get("asyncdemo.webhookonly.create") as Record<string, unknown>;
    expect(webhookOnly.asyncContract).toEqual({
      jobIdField: "job.id",
      terminalStates: ["succeeded", "failed"],
      webhook: {
        webhookOperationId: "asyncdemo.webhookonly.webhook",
        webhookJobIdField: "data.id",
        webhookStateField: "data.status",
        signatureScheme: "hmac_sha256_header",
      },
      instruction: (webhookOnly.asyncContract as { instruction: string }).instruction,
    });
    expect((webhookOnly.asyncContract as { instruction: string }).instruction).toContain(
      "No poll operation exists for this call",
    );
    expect(webhookOnly.asyncContractIssue).toBeUndefined();

    const pollOnly = byId.get("asyncdemo.pollonly.create") as Record<string, unknown>;
    expect(pollOnly.asyncContract).toEqual({
      statusOperationId: "asyncdemo.pollonly.get",
      statusTool: "asyncdemo_get_poll_job",
      statusCli: "asyncdemo pollonly get",
      statusJobIdParam: "job_id",
      jobIdField: "job.id",
      stateField: "job.state",
      terminalStates: ["succeeded", "failed"],
      pendingStates: ["queued", "running"],
      instruction: (pollOnly.asyncContract as { instruction: string }).instruction,
    });
    expect(pollOnly.asyncContractIssue).toBeUndefined();

    const approval = byId.get("asyncdemo.approval.create") as Record<string, unknown>;
    expect((approval.asyncContract as { pendingStates: string[] }).pendingStates).toContain(
      "awaiting_human_input",
    );

    const broken = byId.get("asyncdemo.broken.create") as Record<string, unknown>;
    expect(broken.asyncContract).toBeUndefined();
    expect(broken.asyncContractIssue).toEqual({
      code: "no_completion_source",
      detail:
        "asyncdemo.broken.create declares neither a status operation nor a webhook to complete on",
    });
  });
});

/** The exact printed block for one operation id — from its header line up to (not including) the trailing blank line. */
function blockFor(text: string, operationId: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(`id=${operationId}`));
  if (start === -1) throw new Error(`no block for ${operationId} in:\n${text}`);
  const headerIndent = "  ";
  let end = start + 1;
  while (end < lines.length && lines[end]?.startsWith(`${headerIndent} `)) end++;
  return lines.slice(start, end).join("\n");
}
