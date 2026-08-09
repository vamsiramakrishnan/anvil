import { describe, expect, it } from "vitest";
import { compile } from "../compile.js";

/**
 * Phase 5 (async-events-implementation-plan.md, "Queue systems") — proof by
 * construction that "queue integration" is nothing more than compiling that
 * provider's REST API the same way Anvil already compiles Stripe or GitHub
 * (design doc §12). No new compiler code exists anywhere in this file's
 * import graph: every assertion below runs through the ordinary `compile()`
 * pipeline against an ordinary OpenAPI fixture.
 *
 * Provider chosen for the pull-based slice: **AWS SQS**, reached through an
 * already-authenticated HTTP gateway (Decision B of the implementation
 * plan — SigV4 signing is explicitly out of scope for this phase). Field
 * names are the real ones from AWS's modern JSON protocol
 * (`AmazonSQS.ReceiveMessage` / `AmazonSQS.SendMessage` / `AmazonSQS.DeleteMessage`):
 * `QueueUrl`, `MessageBody`, `MessageAttributes`, `MessageDeduplicationId`,
 * `MessageGroupId`, `ReceiptHandle`, `MaxNumberOfMessages`, `VisibilityTimeout`,
 * `WaitTimeSeconds`, `MessageId`, `Body`, `MD5OfBody` — not the legacy XML
 * query-protocol's `Action=SendMessage&...` form. The gateway itself
 * translates AWS's native single-endpoint JSON-RPC-shaped calls into a
 * friendly per-action REST surface (a real, common API Gateway pattern), and
 * authenticates the caller with an ordinary AIR-supported scheme
 * (`api_key`) — never SigV4.
 */

const sqsGatewaySpec = `openapi: 3.0.3
info: { title: SQS Gateway, version: "1.0.0" }
components:
  securitySchemes:
    GatewayApiKey:
      type: apiKey
      in: header
      name: X-Api-Key
security:
  - GatewayApiKey: []
paths:
  /queues/{queueName}/messages:
    get:
      operationId: receiveMessage
      summary: Retrieve one or more messages from an SQS queue (AmazonSQS.ReceiveMessage)
      parameters:
        - name: queueName
          in: path
          required: true
          schema: { type: string }
        - name: MaxNumberOfMessages
          in: query
          schema: { type: integer, minimum: 1, maximum: 10 }
        - name: VisibilityTimeout
          in: query
          schema: { type: integer }
        - name: WaitTimeSeconds
          in: query
          schema: { type: integer, minimum: 0, maximum: 20 }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  Messages:
                    type: array
                    items:
                      type: object
                      properties:
                        MessageId: { type: string }
                        ReceiptHandle: { type: string }
                        Body: { type: string }
                        MD5OfBody: { type: string }
                        Attributes: { type: object }
    post:
      operationId: sendMessage
      summary: Deliver a message to an SQS queue (AmazonSQS.SendMessage)
      parameters:
        - name: queueName
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                QueueUrl: { type: string }
                MessageBody: { type: string }
                DelaySeconds: { type: integer }
                MessageAttributes: { type: object }
              required: [MessageBody]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  MessageId: { type: string }
                  MD5OfMessageBody: { type: string }
  /queues/{queueName}/messages/{receiptHandle}:
    delete:
      operationId: deleteMessage
      summary: Remove a message from an SQS queue by receipt handle (AmazonSQS.DeleteMessage)
      parameters:
        - name: queueName
          in: path
          required: true
          schema: { type: string }
        - name: receiptHandle
          in: path
          required: true
          schema: { type: string }
      responses:
        "200": { description: OK }
`;

describe("SQS via an authenticated gateway compiles as ordinary AIR operations", () => {
  it("classifies ReceiveMessage as a read — 'peek_next_dlq_message' is just a read operation (design doc §12)", async () => {
    const air = await compile({ spec: sqsGatewaySpec, serviceId: "sqs" });
    const receive = air.operations.find((o) => o.sourceRef.operationId === "receiveMessage");
    expect(receive).toBeDefined();
    expect(receive?.effect.kind).toBe("read");
    expect(receive?.idempotency.mode).toBe("natural");
    expect(receive?.retries).toMatchObject({ mode: "safe", basis: "read_safe" });
    expect(receive?.confirmation.required).toBe(false);
    expect(receive?.archetype).not.toBe("webhook_receiver");
    expect(receive?.auth.type).toBe("api_key");
  });

  it("classifies SendMessage as an ordinary mutation with no idempotency proof by default", async () => {
    const air = await compile({ spec: sqsGatewaySpec, serviceId: "sqs" });
    const send = air.operations.find((o) => o.sourceRef.operationId === "sendMessage");
    expect(send).toBeDefined();
    expect(send?.effect.kind).toBe("mutation");
    expect(send?.effect.action).toBe("send");
    // No MessageDeduplicationId on this (non-FIFO) queue and no manifest claim —
    // the conservative default holds, exactly like any other unproven mutation.
    expect(send?.idempotency.mode).toBe("none");
    expect(send?.retries).toMatchObject({ mode: "none", basis: "unproven" });
    expect(send?.confirmation.required).toBe(true);
  });

  it("classifies DeleteMessage as a naturally idempotent, destructive mutation, delete-by-receipt-handle", async () => {
    const air = await compile({ spec: sqsGatewaySpec, serviceId: "sqs" });
    const del = air.operations.find((o) => o.sourceRef.operationId === "deleteMessage");
    expect(del).toBeDefined();
    expect(del?.effect.kind).toBe("mutation");
    // Not "delete": classify.ts's shared action vocabulary (ACTION_VERB_WORDS,
    // exported so naming.ts/dialect.ts never drift from it) buckets the bare
    // word "message" under the communications/`send` family — real for
    // Twilio's `SendMessage`, a false-positive-shaped quirk here since AWS's
    // own action name is `AmazonSQS.DeleteMessage`. This is genuine, existing,
    // shared-vocabulary behavior (not a queue-specific special case this phase
    // adds), and it doesn't touch the safety core: risk/idempotency/retries
    // derive from the HTTP method and DESTRUCTIVE regex, not from `action`.
    expect(del?.effect.action).toBe("send");
    expect(del?.effect.risk).toBe("destructive");
    expect(del?.idempotency.mode).toBe("natural");
    expect(del?.retries).toMatchObject({ mode: "safe", basis: "natural_idempotent" });
  });

  it("compiles with no diagnostics-level errors — this is an ordinary REST surface, nothing bespoke", async () => {
    const air = await compile({ spec: sqsGatewaySpec, serviceId: "sqs" });
    expect(air.diagnostics.filter((d) => d.level === "error")).toEqual([]);
  });
});

/**
 * §13's direct regression test: SQS FIFO's `MessageDeduplicationId` is a
 * real, caller-supplied carrier and proves `key_supported` through the
 * compiler's EXISTING idempotency-carrier inference
 * (`resolveIdempotencyCarrier`, `@anvil/air`) — no SQS-specific code is
 * added anywhere to make this pass. The manifest states the *claim*
 * (`strategy: key_supported`, pointed at the real body field); the carrier
 * resolver is what *proves* the claim against the field the fixture spec
 * actually declares.
 */
const sqsFifoSendMessageSpec = `openapi: 3.0.3
info: { title: SQS FIFO Gateway, version: "1.0.0" }
components:
  securitySchemes:
    GatewayApiKey:
      type: apiKey
      in: header
      name: X-Api-Key
security:
  - GatewayApiKey: []
paths:
  /queues/{queueName}/messages:
    post:
      operationId: sendMessageFifo
      summary: Deliver a message to an SQS FIFO queue (AmazonSQS.SendMessage)
      parameters:
        - name: queueName
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                QueueUrl: { type: string }
                MessageBody: { type: string }
                MessageGroupId: { type: string }
                MessageDeduplicationId: { type: string }
                MessageAttributes: { type: object }
              required: [MessageBody, MessageGroupId]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  MessageId: { type: string }
                  SequenceNumber: { type: string }
`;

describe("SQS FIFO SendMessage — MessageDeduplicationId proves key_supported idempotency", () => {
  it("classifies key_supported once the manifest claims MessageDeduplicationId as the carrier", async () => {
    const air = await compile({
      spec: sqsFifoSendMessageSpec,
      serviceId: "sqs_fifo",
      manifest: `operations:
  sendMessageFifo:
    idempotency:
      strategy: key_supported
      key_location: body
      field: MessageDeduplicationId
    state: approved
`,
    });
    const send = air.operations.find((o) => o.sourceRef.operationId === "sendMessageFifo");
    expect(send).toBeDefined();
    expect(send?.idempotency).toMatchObject({
      mode: "key_supported",
      mechanism: "body",
      key: "MessageDeduplicationId",
    });
    expect(send?.retries).toMatchObject({ mode: "safe", basis: "idempotency_key" });
    expect(send?.state).toBe("approved");
    expect(
      air.diagnostics.find((d) => d.code === "unsupported_idempotency_carrier"),
    ).toBeUndefined();
  });
});

/**
 * The negative half of §13's finding: standard (non-FIFO) SQS has no
 * dedup-id equivalent, and GCP Pub/Sub's publish API exposes no
 * caller-supplied dedup key at all. Neither may be claimed `key_supported`
 * — one because the field genuinely is not there to claim (the honest,
 * un-enriched default), the other because claiming it anyway is refused by
 * the same carrier-resolution machinery that PROVED the FIFO case above,
 * not a hand-written SQS/Pub-Sub special case.
 */
const pubsubPublishSpec = `openapi: 3.0.3
info: { title: Pub/Sub, version: "1.0.0" }
components:
  securitySchemes:
    GoogleOAuth:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://oauth2.googleapis.com/token
          scopes:
            https://www.googleapis.com/auth/pubsub: Publish and consume Pub/Sub messages
security:
  - GoogleOAuth: [https://www.googleapis.com/auth/pubsub]
paths:
  /v1/{topic}:publish:
    post:
      operationId: publish
      summary: Publish one or more messages to a Pub/Sub topic (projects.topics.publish)
      parameters:
        - name: topic
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                messages:
                  type: array
                  items:
                    type: object
                    properties:
                      data: { type: string }
                      attributes: { type: object }
              required: [messages]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  messageIds:
                    type: array
                    items: { type: string }
`;

describe("standard SQS / Pub/Sub publish must NOT classify key_supported (§13 regression)", () => {
  it("standard (non-FIFO) SendMessage stays at the conservative default with no manifest claim", async () => {
    const air = await compile({ spec: sqsGatewaySpec, serviceId: "sqs" });
    const send = air.operations.find((o) => o.sourceRef.operationId === "sendMessage");
    expect(send?.idempotency.mode).toBe("none");
    expect(send?.retries.basis).toBe("unproven");
    expect(send?.retries.mode).toBe("none");
  });

  it("Pub/Sub publish stays at the conservative default with no manifest claim (no caller-supplied dedup key exists)", async () => {
    const air = await compile({ spec: pubsubPublishSpec, serviceId: "pubsub" });
    const publish = air.operations.find((o) => o.sourceRef.operationId === "publish");
    expect(publish).toBeDefined();
    expect(publish?.effect.kind).toBe("mutation");
    expect(publish?.idempotency.mode).toBe("none");
    expect(publish?.retries.basis).toBe("unproven");
  });

  it("a wrongly claimed key_supported on standard SendMessage is refused, not silently accepted", async () => {
    // The same manifest shape that legitimately proved the FIFO case above,
    // pointed at a field that does not exist on this (non-FIFO) queue's
    // request body — the carrier resolver refuses to invent it.
    const air = await compile({
      spec: sqsGatewaySpec,
      serviceId: "sqs",
      manifest: `operations:
  sendMessage:
    idempotency:
      strategy: key_supported
      key_location: body
      field: MessageDeduplicationId
    state: approved
`,
    });
    const send = air.operations.find((o) => o.sourceRef.operationId === "sendMessage");
    expect(send?.state).toBe("blocked");
    expect(send?.retries).toMatchObject({ mode: "none", basis: "unproven" });
    expect(air.diagnostics.find((d) => d.code === "unsupported_idempotency_carrier")).toMatchObject(
      { level: "error", operationId: send?.id },
    );
  });

  it("a wrongly claimed key_supported on Pub/Sub publish is refused, not silently accepted", async () => {
    const air = await compile({
      spec: pubsubPublishSpec,
      serviceId: "pubsub",
      manifest: `operations:
  publish:
    idempotency:
      strategy: key_supported
      key_location: body
      field: messageDeduplicationId
    state: approved
`,
    });
    const publish = air.operations.find((o) => o.sourceRef.operationId === "publish");
    expect(publish?.state).toBe("blocked");
    expect(air.diagnostics.find((d) => d.code === "unsupported_idempotency_carrier")).toMatchObject(
      { level: "error", operationId: publish?.id },
    );
  });
});
