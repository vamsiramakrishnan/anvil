import { describe, expect, it } from "vitest";
import { compile } from "../compile.js";
import { callbackWebhookLink, webhookPathItems } from "./webhooks.js";

/**
 * GitHub's real published REST description
 * (github/rest-api-description, api.github.com.json) does NOT declare a
 * top-level OpenAPI 3.1 `webhooks:` map — it is pinned to `openapi: 3.0.3`
 * and carries its 270 webhook events under the vendor extension `x-webhooks`
 * instead (confirmed by fetching the real file: top-level keys are
 * `openapi, info, tags, servers, externalDocs, paths, x-webhooks,
 * components`; no `webhooks` key). So GitHub is not directly usable as the
 * "real spec has webhooks:" fixture §16/§19 of the design doc asked to
 * verify — this is the negative half of that verification.
 *
 * What follows is still GitHub's real content, reshaped: the exact event
 * name, operationId convention, header set (`X-Hub-Signature-256`, its
 * `sha256=` prefix, `X-GitHub-Event`, `X-GitHub-Delivery`), and a trimmed
 * slice of the real `webhook-branch-protection-configuration-disabled`
 * payload schema — copied from the fetched file and re-declared under a
 * real OpenAPI 3.1 `webhooks:` key with `openapi: 3.1.0`, the shape Anvil's
 * compiler targets (§10 of the async design doc scopes v1 to 3.1's native
 * keyword only). This is "a trimmed real excerpt", per the task, adapted
 * only in the one respect GitHub's own spec cannot supply: the 3.1 `webhooks:`
 * envelope itself.
 */
const githubShapedWebhooksSpec = `openapi: 3.1.0
info: { title: GitHub-shaped webhooks, version: 1.0.0 }
paths:
  /repos/{owner}/{repo}/exports:
    post:
      operationId: startRepoExport
      summary: Start a repository export
      parameters:
        - name: owner
          in: path
          required: true
          schema: { type: string }
        - name: repo
          in: path
          required: true
          schema: { type: string }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                callback_url: { type: string }
      responses:
        "202":
          description: accepted
          content:
            application/json:
              schema:
                type: object
                properties:
                  export: { type: object, properties: { id: { type: string } } }
      callbacks:
        exportCompleted:
          "{$request.body#/callback_url}":
            $ref: "#/webhooks/repository-export-completed"
webhooks:
  repository-export-completed:
    post:
      operationId: repository-export/completed
      summary: This event occurs when a repository export finishes.
      parameters:
        - name: X-GitHub-Event
          in: header
          example: repository_export
          schema: { type: string }
        - name: X-GitHub-Delivery
          in: header
          example: 0b989ba4-242f-11e5-81e1-c7b6966d2516
          schema: { type: string }
        - name: X-Hub-Signature-256
          in: header
          example: sha256=6dcb09b5b57875f334f61aebed695e2e4193db5e
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              properties:
                action: { type: string, enum: ["completed"] }
                export:
                  type: object
                  additionalProperties: false
                  properties:
                    id: { type: string }
                    status: { type: string, enum: ["succeeded", "failed", "in_progress"] }
                repository:
                  type: object
                  properties:
                    id: { type: integer }
                    full_name: { type: string }
                sender:
                  type: object
                  properties:
                    login: { type: string }
              required: ["action", "repository", "sender"]
      responses:
        "200":
          description: Return a 200 status to indicate that the data was received successfully
  branch-protection-configuration-disabled:
    post:
      operationId: branch-protection-configuration/disabled
      summary: All branch protections were disabled for a repository.
      parameters:
        - name: X-GitHub-Event
          in: header
          example: branch_protection_configuration
          schema: { type: string }
        - name: X-Hub-Signature-256
          in: header
          example: sha256=6dcb09b5b57875f334f61aebed695e2e4193db5e
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                action: { type: string, enum: ["disabled"] }
                repository: { type: object }
                sender: { type: object }
              required: ["action", "repository", "sender"]
      responses:
        "200":
          description: Return a 200 status to indicate that the data was received successfully
`;

describe("webhookPathItems", () => {
  it("reprojects webhooks: into a paths:-shaped map with the two vendor extensions stamped", () => {
    const items = webhookPathItems({
      openapi: "3.1.0",
      webhooks: {
        "order-shipped": {
          post: { operationId: "orderShipped", responses: { "200": { description: "ok" } } },
        },
      },
    });
    expect(Object.keys(items)).toEqual(["/webhooks/order-shipped"]);
    const post = items["/webhooks/order-shipped"]?.post as Record<string, unknown>;
    expect(post["x-anvil-webhook"]).toBe(true);
    expect(post["x-anvil-effect"]).toBe("read");
    expect(post.operationId).toBe("orderShipped");
  });

  it("returns an empty map for a document with no webhooks:", () => {
    expect(webhookPathItems({ openapi: "3.1.0" })).toEqual({});
  });

  it("ignores non-method keys on a Path Item (e.g. shared parameters)", () => {
    const items = webhookPathItems({
      openapi: "3.1.0",
      webhooks: {
        pinged: {
          parameters: [{ name: "X-Hub-Signature-256", in: "header" }],
          post: { operationId: "pinged", responses: { "200": { description: "ok" } } },
        },
      },
    });
    const pathItem = items["/webhooks/pinged"];
    expect(pathItem?.parameters).toBeDefined();
    expect((pathItem?.post as Record<string, unknown> | undefined)?.["x-anvil-webhook"]).toBe(true);
  });
});

describe("callbackWebhookLink", () => {
  const webhooks = {
    "export-completed": {
      post: { operationId: "exportCompleted", responses: { "200": { description: "ok" } } },
    },
  };

  it("matches a callbacks: Path Item that is byte-identical to a webhooks: entry", () => {
    const callbacks = {
      done: {
        "{$request.body#/callback_url}": {
          post: { operationId: "exportCompleted", responses: { "200": { description: "ok" } } },
        },
      },
    };
    expect(callbackWebhookLink(callbacks, webhooks)).toBe("export-completed");
  });

  it("is insensitive to key order (content, not text, is what must match)", () => {
    const callbacks = {
      done: {
        "{$request.body#/callback_url}": {
          post: { responses: { "200": { description: "ok" } }, operationId: "exportCompleted" },
        },
      },
    };
    expect(callbackWebhookLink(callbacks, webhooks)).toBe("export-completed");
  });

  it("refuses a near-miss rather than guessing (no fuzzy matching)", () => {
    const callbacks = {
      done: {
        "{$request.body#/callback_url}": {
          post: {
            operationId: "exportCompletedDifferently",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    expect(callbackWebhookLink(callbacks, webhooks)).toBeUndefined();
  });

  it("returns undefined with no callbacks: at all", () => {
    expect(callbackWebhookLink(undefined, webhooks)).toBeUndefined();
  });

  it("returns undefined with no webhooks: to match against", () => {
    expect(callbackWebhookLink({ done: {} }, undefined)).toBeUndefined();
  });
});

describe("end-to-end: compiling a GitHub-shaped webhooks: spec", () => {
  it("archetypes every webhooks:-sourced operation webhook_receiver", async () => {
    const air = await compile({ spec: githubShapedWebhooksSpec, serviceId: "github" });
    const webhookOps = air.operations.filter((o) => o.archetype === "webhook_receiver");
    expect(webhookOps.length).toBe(2);
    expect(webhookOps.every((o) => o.effect.kind === "read")).toBe(true);
    expect(webhookOps.map((o) => o.sourceRef.path).sort()).toEqual([
      "/webhooks/branch-protection-configuration-disabled",
      "/webhooks/repository-export-completed",
    ]);
  });

  it("excludes webhook receivers from the callable (non-receiver) operation surface", async () => {
    const air = await compile({ spec: githubShapedWebhooksSpec, serviceId: "github" });
    const callable = air.operations.filter((o) => o.archetype !== "webhook_receiver");
    expect(callable.length).toBe(1);
    expect(callable[0]?.sourceRef.path).toBe("/repos/{owner}/{repo}/exports");
  });

  it("auto-populates an asyncContract.webhook evidence link from the explicit callbacks: reference", async () => {
    const air = await compile({ spec: githubShapedWebhooksSpec, serviceId: "github" });
    const submit = air.operations.find((o) => o.sourceRef.path === "/repos/{owner}/{repo}/exports");
    expect(submit?.longRunning).toBe(true);
    const claim = submit?.evidence.claims.find((c) => c.predicate === "asyncContract.webhook");
    expect(claim).toBeDefined();
    expect(claim?.note).toContain("repository-export-completed");
    expect(claim?.note).toContain("candidate webhookJobIdField");
    // Never written directly onto the contract — signatureVerification cannot
    // be derived from the spec, and half a contract is worse than none.
    expect(submit?.asyncContract?.webhook).toBeUndefined();
  });

  it("leaves the webhook link unset with bare webhooks: and no callbacks: reference", async () => {
    const bareSpec = `openapi: 3.1.0
info: { title: Bare webhooks, version: 1.0.0 }
paths:
  /exports:
    post:
      operationId: startExport
      responses:
        "202":
          description: accepted
          content:
            application/json:
              schema:
                type: object
                properties: { job: { type: object, properties: { id: { type: string } } } }
webhooks:
  export-completed:
    post:
      operationId: exportCompleted
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties: { job: { type: object, properties: { id: { type: string } } } }
      responses:
        "200": { description: ok }
`;
    const air = await compile({ spec: bareSpec, serviceId: "bare" });
    const submit = air.operations.find((o) => o.sourceRef.path === "/exports");
    expect(submit?.longRunning).toBe(true);
    expect(submit?.evidence.claims.some((c) => c.predicate === "asyncContract.webhook")).toBe(
      false,
    );
    expect(submit?.asyncContract?.webhook).toBeUndefined();
    const webhookOp = air.operations.find((o) => o.archetype === "webhook_receiver");
    expect(webhookOp).toBeDefined();
  });
});
