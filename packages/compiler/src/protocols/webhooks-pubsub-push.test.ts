import { describe, expect, it } from "vitest";
import { compile } from "../compile.js";
import { webhookPathItems } from "./webhooks.js";

/**
 * GCP Pub/Sub push delivery, wired through Phase 1's `webhooks:` compiler
 * (`webhookPathItems`) and Phase 2's existing receiver (`handleWebhook`'s
 * `oidc_jwt` scheme — `packages/runtime/src/webhook-receiver.ts`), per the
 * design doc's §12: "[Pub/Sub] push delivers a message as an HTTP POST to a
 * configured endpoint — which is architecturally identical to §7's webhook
 * receiver. The only new piece is the verification scheme
 * ... exactly §9's new oidc_jwt variant. A queue-push subscription is a
 * webhook with a different signature scheme, not a new component."
 *
 * This file proves that literally, at the compiler layer: a real Pub/Sub
 * push-subscription request body (`{ message: { data, attributes,
 * messageId, publishTime }, subscription }`, the exact envelope GCP's own
 * push documentation specifies) declared as an ordinary OpenAPI 3.1
 * `webhooks:` entry compiles through `webhookPathItems` with ZERO extension
 * — the same generic reprojection GitHub's `webhooks.test.ts` fixture
 * already exercises. No Pub/Sub-specific branch exists in
 * `protocols/webhooks.ts`, and none was added for this phase.
 */
const pubsubPushSpec = `openapi: 3.1.0
info: { title: Orders, version: 1.0.0 }
paths:
  /orders:
    post:
      operationId: createOrder
      summary: Create an order; completion is delivered asynchronously via Pub/Sub push
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  order:
                    type: object
                    properties: { id: { type: string } }
webhooks:
  order-events-push:
    post:
      operationId: orderEventsPush
      summary: GCP Pub/Sub push delivery for the order-events subscription
      parameters:
        - name: Authorization
          in: header
          required: true
          description: "Bearer <OIDC identity token minted by Pub/Sub's push service account>"
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              properties:
                message:
                  type: object
                  properties:
                    data: { type: string, description: "base64-encoded message body" }
                    attributes: { type: object }
                    messageId: { type: string }
                    publishTime: { type: string }
                  required: [data, messageId]
                subscription: { type: string }
              required: [message, subscription]
      responses:
        "200":
          description: Return a 200 status to acknowledge the push message
`;

describe("webhookPathItems handles a Pub/Sub-shaped push subscription with zero extension", () => {
  it("reprojects the Pub/Sub push subscription the same way it reprojects any other webhooks: entry", () => {
    const items = webhookPathItems({
      openapi: "3.1.0",
      webhooks: {
        "order-events-push": {
          post: {
            operationId: "orderEventsPush",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      message: { type: "object", properties: { messageId: { type: "string" } } },
                      subscription: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "ack" } },
          },
        },
      },
    });
    expect(Object.keys(items)).toEqual(["/webhooks/order-events-push"]);
    const post = items["/webhooks/order-events-push"]?.post as Record<string, unknown>;
    expect(post["x-anvil-webhook"]).toBe(true);
    expect(post["x-anvil-effect"]).toBe("read");
  });
});

describe("end-to-end: compiling a Pub/Sub-shaped webhooks: spec", () => {
  it("archetypes the push subscription webhook_receiver, read, never directly callable", async () => {
    const air = await compile({ spec: pubsubPushSpec, serviceId: "orders" });
    const webhookOps = air.operations.filter((o) => o.archetype === "webhook_receiver");
    expect(webhookOps.length).toBe(1);
    expect(webhookOps[0]?.sourceRef.path).toBe("/webhooks/order-events-push");
    expect(webhookOps[0]?.effect.kind).toBe("read");
    const callable = air.operations.filter((o) => o.archetype !== "webhook_receiver");
    expect(callable.map((o) => o.sourceRef.path)).toEqual(["/orders"]);
  });

  it("wires the push subscription onto createOrder's asyncContract.webhook with the oidc_jwt scheme via manifest", async () => {
    const compiled = await compile({ spec: pubsubPushSpec, serviceId: "orders" });
    const webhookId = compiled.operations.find((o) => o.archetype === "webhook_receiver")?.id;
    expect(webhookId).toBeDefined();

    const air = await compile({
      spec: pubsubPushSpec,
      serviceId: "orders",
      manifest: `operations:
  createOrder:
    async_contract:
      job_id_field: order.id
      webhook:
        operation: ${webhookId}
        job_id_field: message.messageId
        signature_verification:
          scheme: oidc_jwt
          header_name: Authorization
          expected_issuer: https://accounts.google.com
          expected_audience_ref: pubsub_push_audience
`,
    });
    const submit = air.operations.find(
      (o) => o.sourceRef.path === "/orders" && o.sourceRef.method === "post",
    );
    // This is the SAME shape `webhook-receiver.test.ts`'s "oidc_jwt (GCP
    // Pub/Sub push-shaped)" describe block hand-builds as a `WebhookContract`
    // literal to drive `handleWebhook()` — proving compile-time construction
    // and the runtime's existing verification contract agree byte-for-byte.
    expect(submit?.asyncContract).toEqual({
      jobIdField: "order.id",
      terminalStates: [],
      pendingStates: [],
      webhook: {
        webhookOperationId: webhookId,
        webhookJobIdField: "message.messageId",
        signatureVerification: {
          scheme: "oidc_jwt",
          headerName: "Authorization",
          expectedIssuer: "https://accounts.google.com",
          expectedAudienceRef: "pubsub_push_audience",
        },
      },
    });
  });
});
