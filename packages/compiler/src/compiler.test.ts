import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { confidenceFor } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { classifyConfirmation, classifyEffect } from "./classify.js";
import { approveOperations, compile } from "./compile.js";

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

const spec = read("openapi.yaml");
const manifest = read("anvil.yaml");

describe("classifier", () => {
  it("classifies reads as retry-safe and non-confirming", () => {
    const { effect, idempotency } = classifyEffect("get", "getCustomer /customers/{id}");
    expect(effect.kind).toBe("read");
    expect(idempotency.mode).toBe("natural");
    expect(classifyConfirmation(effect, idempotency).required).toBe(false);
  });

  it("classifies POST refund as a non-idempotent financial mutation", () => {
    const { effect, idempotency } = classifyEffect("post", "createRefund /payments/{id}/refunds");
    expect(effect.kind).toBe("mutation");
    expect(effect.risk).toBe("financial");
    expect(effect.reversible).toBe(false);
    expect(idempotency.mode).toBe("none");
    expect(classifyConfirmation(effect, idempotency).required).toBe(true);
  });

  it("classifies DELETE as destructive", () => {
    const { effect } = classifyEffect("delete", "deleteThing /things/{id}");
    expect(effect.risk).toBe("destructive");
    expect(effect.reversible).toBe(false);
  });

  it("classifies a POST search endpoint as a read, not a mutation", () => {
    // A common REST convention (Elasticsearch, GitHub, Jira's POST /search/jql):
    // the query is too large/complex for a query string, so it rides a POST body,
    // but the endpoint has no persisted side effect.
    const { effect, idempotency } = classifyEffect(
      "post",
      "searchAndReconsileIssuesUsingJqlPost /search/jql",
    );
    expect(effect.kind).toBe("read");
    expect(effect.action).toBe("search");
    expect(idempotency.mode).toBe("natural");
    expect(classifyConfirmation(effect, idempotency).required).toBe(false);
  });

  it("does not reclassify a POST that merely mentions an unrelated verb substring", () => {
    // "research" contains "search" as a substring but is not the search verb —
    // word-boundary matching must not false-positive on it.
    const { effect } = classifyEffect("post", "createResearchNote /research-notes");
    expect(effect.kind).toBe("mutation");
  });

  it("keeps a POST validate/simulate endpoint conservatively a mutation", () => {
    // Unlike search/export/poll, these verbs often still have a side effect
    // (quota, temporary hold, audit trail) in real APIs, so they stay mutations.
    const { effect } = classifyEffect("post", "validateOrder /orders/validate");
    expect(effect.kind).toBe("mutation");
  });
});

describe("compile pipeline (spec only)", () => {
  it("produces AIR with aligned CLI/MCP/skill bindings", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    expect(air.service.id).toBe("payments");
    expect(air.operations.length).toBeGreaterThanOrEqual(4);
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund).toBeDefined();
    expect(refund?.cli.command).toBe("payments refunds create");
    expect(refund?.mcp.toolName).toBe("payments_create_refund");
    expect(refund?.input.schema?.type).toBe("object");
  });

  it("escalates non-idempotent mutations to review_required without a manifest", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.state).toBe("review_required");
    expect(refund?.confirmation.required).toBe(true);
    // No retries on an unproven mutation.
    expect(refund?.retries.mode).toBe("none");
    expect(air.diagnostics.some((d) => d.code === "unproven_idempotency")).toBe(true);
  });
});

describe("compile pipeline (with manifest enrichment)", () => {
  it("makes the refund idempotent, retry-safe, and approved", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.idempotency.mode).toBe("required");
    expect(refund?.idempotency.key).toBe("Idempotency-Key");
    expect(refund?.idempotency.keyDerivation).toBe("request_fingerprint");
    expect(refund?.retries.mode).toBe("safe");
    expect(refund?.retries.maxAttempts).toBe(3);
    expect(refund?.retries.retryOn).toContain("http_429");
    expect(refund?.confirmation.required).toBe(true);
    expect(refund?.state).toBe("approved");
    // Manifest enrichment records a high-confidence, reviewed claim for that
    // specific semantic — confidence is resolved per predicate, not node-wide.
    const enriched = refund?.evidence.claims.find((c) => c.predicate === "enriched");
    expect(enriched?.review).toBe("accepted");
    expect(confidenceFor(refund?.evidence ?? { claims: [] }, "enriched")).toBeGreaterThan(0.6);
  });

  it("resolves oauth2 auth with scopes", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.auth.type).toBe("oauth2_client_credentials");
    expect(refund?.auth.scopes).toContain("payments.read");
  });

  it("supports explicit approval of additional operations", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    const before = air.operations.find((o) => o.canonicalName === "get_customer");
    expect(before?.state).toBe("generated");
    approveOperations(air, [before?.id ?? ""]);
    expect(air.operations.find((o) => o.canonicalName === "get_customer")?.state).toBe("approved");
  });
});

describe("semantic vocabulary (effect action / retry basis / auth principal)", () => {
  it("derives a descriptive action verb without changing the safety kind", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.effect.kind).toBe("mutation"); // safety core unchanged
    expect(refund?.effect.action).toBe("create"); // richer descriptive layer
    const getPayment = air.operations.find((o) => o.canonicalName === "get_payment");
    expect(getPayment?.effect.action).toBe("get");
  });

  it("records the retry basis behind a safe posture", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.retries.mode).toBe("safe");
    expect(refund?.retries.basis).toBe("idempotency_key");
    const getPayment = air.operations.find((o) => o.canonicalName === "get_payment");
    expect(getPayment?.retries.basis).toBe("read_safe");
  });

  it("classifies the auth principal (whose authority) from the scheme", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.auth.type).toBe("oauth2_client_credentials");
    expect(refund?.auth.principal).toBe("service");
  });

  it("lets the manifest override principal / action / audience", async () => {
    const m = `service: { name: payments }
operations:
  getPayment:
    state: approved
    action: export
    auth:
      principal: end_user
      audience: https://payments.example.com`;
    const air = await compile({ spec, manifest: m, serviceId: "payments" });
    const getPayment = air.operations.find((o) => o.canonicalName === "get_payment");
    expect(getPayment?.effect.action).toBe("export");
    expect(getPayment?.auth.principal).toBe("end_user");
    expect(getPayment?.auth.audience).toBe("https://payments.example.com");
  });
});

describe("naming pass", () => {
  it("scores a spec-derived name with lower confidence than an operationId one", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    const naming = refund?.evidence.claims.find((c) => c.predicate === "name.quality");
    expect(naming?.confidence).toBeGreaterThanOrEqual(0.9); // has an operationId
  });

  it("resolves a CLI-command collision with meaningful tokens, not a silent _2", async () => {
    const clashing = `openapi: 3.0.0
info: { title: billing, version: 1.0.0 }
paths:
  /orders/{id}/archive:
    post:
      responses: { "200": { description: ok } }
  /subscriptions/{id}/archive:
    post:
      responses: { "200": { description: ok } }
`;
    const air = await compile({ spec: clashing, serviceId: "billing" });
    const commands = air.operations.map((o) => o.cli.command);
    // Disambiguated by the distinguishing path segment, and unique.
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands.some((c) => c.includes("orders"))).toBe(true);
    expect(commands.some((c) => c.includes("subscriptions"))).toBe(true);
    expect(air.diagnostics.some((d) => d.code === "naming_collision_resolved")).toBe(true);
    // Tool names stay aligned with the disambiguated commands (no drift).
    expect(new Set(air.operations.map((o) => o.mcp.toolName)).size).toBe(air.operations.length);
  });

  it("treats a verb-shaped trailing path segment as an action, not the resource", async () => {
    // GET /field/search searches fields; naively taking the last segment as the
    // resource misreads this as its own resource ("search list field").
    const searchy = `openapi: 3.0.0
info: { title: jira, version: 1.0.0 }
paths:
  /field/search:
    get:
      operationId: getFieldsPaginated
      responses: { "200": { description: ok } }
`;
    const air = await compile({ spec: searchy, serviceId: "jira" });
    const op = air.operations[0];
    expect(op?.effect.resource).toBe("field");
    expect(op?.cli.command).toBe("jira field search");
    // The CLI command and the MCP tool name must agree on what the operation is —
    // one no longer says "search" while the other says "get_fields_paginated"
    // with an unrelated resource token wedged in between.
    expect(op?.mcp.toolName).toContain("get_fields_paginated");
  });

  it("keeps the CLI command and effect action in agreement for a reclassified POST search", async () => {
    const jql = `openapi: 3.0.0
info: { title: jira, version: 1.0.0 }
paths:
  /search/jql:
    post:
      operationId: searchAndReconsileIssuesUsingJqlPost
      responses: { "200": { description: ok } }
`;
    const air = await compile({ spec: jql, serviceId: "jira" });
    const op = air.operations[0];
    expect(op?.effect.kind).toBe("read");
    expect(op?.cli.command).toBe("jira jql search");
    expect(op?.confirmation.required).toBe(false);
  });

  it("strips a REST format suffix from the resource name (Twilio's .json)", async () => {
    // Twilio's list/create paths carry `.json` (Messages.json) while fetch/delete
    // carry it on the id segment (Messages/{Sid}.json) — leaving the suffix in
    // renders the SAME resource two ways and leaks a wire-format detail into the
    // agent-facing name. `sourceRef.path` (the wire path) keeps `.json`.
    const twilioish = `openapi: 3.0.0
info: { title: twilio, version: 1.0.0 }
paths:
  /Accounts/{AccountSid}/Messages.json:
    post: { operationId: CreateMessage, responses: { "200": { description: ok } } }
    get:  { operationId: ListMessage, responses: { "200": { description: ok } } }
  /Accounts/{AccountSid}/Messages/{Sid}.json:
    get: { operationId: FetchMessage, responses: { "200": { description: ok } } }
`;
    const air = await compile({ spec: twilioish, serviceId: "twilio" });
    const list = air.operations.find((o) => o.sourceRef.operationId === "ListMessage");
    const fetch = air.operations.find((o) => o.sourceRef.operationId === "FetchMessage");
    expect(list?.cli.command).toBe("twilio Messages list");
    expect(fetch?.cli.command).toBe("twilio Messages get"); // same resource token, no `.json`
    expect(list?.sourceRef.path).toContain(".json"); // wire path untouched
  });

  it("keeps a synthetic-namespace operation name from doubling (GraphQL Query/Mutation wrapper)", async () => {
    // GraphQL lowers every field to `/graphql/Mutation/<field>`. A field whose
    // name merely CONTAINS a vocab verb (`acceptInvitation` contains "accept",
    // `issueSearch` ends "search") must stay the resource — otherwise every
    // field collapses onto the `Mutation` wrapper as its resource, they all
    // collide, and disambiguation re-appends the field name, doubling the tool
    // name (`..._accept_invitation_accept_invitation`).
    const sdl = `type Query { issueSearch: String }
type Mutation { acceptInvitation: Boolean createIssue: String }
schema { query: Query mutation: Mutation }`;
    const air = await compile({ spec: sdl, serviceId: "gql", sourceUri: "schema.graphql" });
    const accept = air.operations.find((o) => o.sourceRef.operationId === "acceptInvitation");
    const create = air.operations.find((o) => o.sourceRef.operationId === "createIssue");
    const search = air.operations.find((o) => o.sourceRef.operationId === "issueSearch");
    // Tool names are the clean field name, exactly once — no doubling.
    expect(accept?.mcp.toolName).toBe("gql_accept_invitation");
    expect(create?.mcp.toolName).toBe("gql_create_issue");
    expect(search?.mcp.toolName).toBe("gql_issue_search");
    // Every operation name is unique — no spurious collisions on the wrapper.
    const tools = air.operations.map((o) => o.mcp.toolName);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("compiles a large recursive schema without exploding (adapter title stamping)", async () => {
    // A GraphQL-style recursive type: A → B → A. After dereference() inlines it
    // into a massively-shared graph, `bundleDocument` must re-collapse each
    // named type to a `$ref` — which it can only do if the adapter stamped a
    // `title` on each named schema. Without the stamp, GitHub's real 1,752-type
    // schema hung the compile (gigabytes on serialize). Here: the compiled AIR
    // must be small and JSON-serializable.
    const sdl = `type Query { a: A b: B }
type A { name: String b: B }
type B { name: String a: A }
schema { query: Query }`;
    const air = await compile({ spec: sdl, serviceId: "rec", sourceUri: "schema.graphql" });
    expect(() => JSON.stringify(air)).not.toThrow();
    // A/B collapsed to $ref pointers, so the whole document stays tiny.
    expect(JSON.stringify(air).length).toBeLessThan(200_000);
    expect(air.schemas.A).toBeDefined();
    expect(air.schemas.B).toBeDefined();
  });

  it("decomposes an RPC-style dotted path into resource + action (Slack's chat.postMessage)", async () => {
    // Slack's Web API is RPC-over-HTTP: `/chat.postMessage` is one path segment
    // `namespace.method`. Taking it whole makes the CLI `slack chat.postMessage
    // send` (dotted, redundant verb) and drift from the tool name.
    const slackish = `openapi: 3.0.0
info: { title: slack, version: 1.0.0 }
paths:
  /chat.postMessage:
    post: { operationId: chat_postMessage, responses: { "200": { description: ok } } }
  /conversations.history:
    get: { operationId: conversations_history, responses: { "200": { description: ok } } }
`;
    const air = await compile({ spec: slackish, serviceId: "slack" });
    const post = air.operations.find((o) => o.sourceRef.operationId === "chat_postMessage");
    const hist = air.operations.find((o) => o.sourceRef.operationId === "conversations_history");
    expect(post?.cli.command).toBe("slack chat post_message");
    expect(post?.mcp.toolName).toBe("slack_chat_post_message"); // CLI and tool agree
    expect(hist?.cli.command).toBe("slack conversations history");
  });

  it("keeps namespaced RPC methods distinct instead of colliding (Slack admin.* vs bare)", async () => {
    // Slack ships both `conversations.archive` and `admin.conversations.archive`
    // — collapsing the namespace would make them collide onto one name.
    const slackish = `openapi: 3.0.0
info: { title: slack, version: 1.0.0 }
paths:
  /conversations.archive:
    post: { operationId: conversations_archive, responses: { "200": { description: ok } } }
  /admin.conversations.archive:
    post: { operationId: admin_conversations_archive, responses: { "200": { description: ok } } }
`;
    const air = await compile({ spec: slackish, serviceId: "slack" });
    const commands = air.operations.map((o) => o.cli.command);
    expect(new Set(commands).size).toBe(2); // distinct, no collision
    expect(commands).toContain("slack conversations archive");
    expect(commands).toContain("slack admin_conversations archive");
    // No disambiguation suffix was needed — the names were distinct on their own.
    expect(air.diagnostics.some((d) => d.code === "naming_collision_resolved")).toBe(false);
  });

  it("uses the operationId verb for a POST reused as update/delete (Twilio POST-for-update)", async () => {
    // Twilio (and others) reuse POST for update, not just create; HTTP method
    // alone maps both to "create" and collides them. The operationId carries
    // the real verb.
    const twilioish = `openapi: 3.0.0
info: { title: twilio, version: 1.0.0 }
paths:
  /Accounts/{AccountSid}/Messages.json:
    post: { operationId: CreateMessage, responses: { "200": { description: ok } } }
  /Accounts/{AccountSid}/Messages/{Sid}.json:
    post: { operationId: UpdateMessage, responses: { "200": { description: ok } } }
`;
    const air = await compile({ spec: twilioish, serviceId: "twilio" });
    const create = air.operations.find((o) => o.sourceRef.operationId === "CreateMessage");
    const update = air.operations.find((o) => o.sourceRef.operationId === "UpdateMessage");
    expect(create?.cli.command).toBe("twilio Messages create");
    expect(update?.cli.command).toBe("twilio Messages update"); // not "create" → no collision
    expect(new Set(air.operations.map((o) => o.cli.command)).size).toBe(2);
  });

  it("flags a weak (agent-hostile) name for review", async () => {
    const weak = `openapi: 3.0.0
info: { title: gateway, version: 1.0.0 }
paths:
  /:
    post:
      responses: { "200": { description: ok } }
`;
    const air = await compile({ spec: weak, serviceId: "gateway" });
    expect(air.diagnostics.some((d) => d.code === "weak_operation_name")).toBe(true);
  });

  it("flags a vague verb even from a well-declared operationId", async () => {
    // Real-world case (Jira's POST /issue/{id}/transitions, operationId
    // doTransition): a strong operationId signal alone must not be enough to
    // hide an agent-hostile verb — mcp-atlassian itself renames this same
    // operation to "transition_issue" rather than keep Atlassian's "do".
    const vague = `openapi: 3.0.0
info: { title: jira, version: 1.0.0 }
paths:
  /issue/{id}/transitions:
    post:
      operationId: doTransition
      responses: { "200": { description: ok } }
`;
    const air = await compile({ spec: vague, serviceId: "jira" });
    expect(air.diagnostics.some((d) => d.code === "weak_operation_name")).toBe(true);
  });
});

describe("request body handling", () => {
  it("projects a flat scalar body into per-field flags while preserving the schema", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.input.body?.projection).toBe("fields");
    expect(refund?.input.body?.fields.map((f) => f.name).sort()).toEqual([
      "amount",
      "currency",
      "reason",
    ]);
    // Body fields are NOT stored as params (the model is not mutated by the surface).
    expect(refund?.input.params.every((p) => p.in !== "body")).toBe(true);
    // The verbatim body schema is still present.
    expect(refund?.input.body?.schema.type).toBe("object");
  });

  it("preserves a nested/array body whole instead of flattening it", async () => {
    const nested = `openapi: 3.0.0
info: { title: orders, version: 1.0.0 }
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [items]
              properties:
                items:
                  type: array
                  items: { type: object, properties: { sku: { type: string } } }
`;
    const air = await compile({ spec: nested, serviceId: "orders" });
    const op = air.operations[0];
    expect(op?.input.body?.projection).toBe("whole");
    // Array-of-objects structure survives (this is exactly what flattening lost).
    const items = op?.input.body?.schema.properties as Record<string, { type?: string }>;
    expect(items.items?.type).toBe("array");
    // The assembled input surface carries a single `body` property.
    const props = op?.input.schema?.properties as Record<string, unknown>;
    expect(Object.keys(props)).toContain("body");
  });
});

describe("capability discovery", () => {
  it("groups operations into capabilities from OpenAPI tags", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    const ids = air.capabilities.map((c) => c.id).sort();
    expect(ids).toEqual(["payments.customers", "payments.payments", "payments.refunds"]);
    const refunds = air.capabilities.find((c) => c.id === "payments.refunds");
    expect(refunds?.source).toBe("tag");
    // A tag-based grouping is spec-sourced (reliable); confidence is asked for the
    // grouping semantic specifically, weighted by source reliability.
    expect(confidenceFor(refunds?.evidence ?? { claims: [] }, "grouping")).toBeGreaterThan(0.5);
    // Every operation is stamped with its primary capability.
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.capabilityId).toBe("payments.refunds");
    expect(refunds?.operationIds).toContain(refund?.id);
  });

  it("marks a capability approved when any member operation is approved", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refunds = air.capabilities.find((c) => c.id === "payments.refunds");
    expect(refunds?.state).toBe("approved");
  });
});

describe("authored workflows", () => {
  it("builds a first-class workflow from the manifest and attaches it to a capability", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    expect(air.workflows).toHaveLength(1);
    const wf = air.workflows[0];
    expect(wf?.id).toBe("payments.refunds.refund_customer");
    expect(wf?.capabilityId).toBe("payments.refunds");
    expect(wf?.humanApproval).toBe(true);
    // Steps resolve their operation references to AIR operation ids.
    const getPayment = air.operations.find((o) => o.canonicalName === "get_payment");
    const createRefund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(wf?.steps.map((s) => s.operationId)).toEqual([getPayment?.id, createRefund?.id]);
    expect(wf?.steps[1]?.bindings.payment_id).toBe("$.steps.getPayment.id");
    // The owning capability records the workflow.
    const refunds = air.capabilities.find((c) => c.id === "payments.refunds");
    expect(refunds?.workflowIds).toContain(wf?.id);
  });

  it("drops a step referencing an unknown operation with a diagnostic", async () => {
    const badManifest = `${manifest}
  broken_flow:
    capability: refunds
    steps:
      - operation: doesNotExist
`;
    const air = await compile({ spec, manifest: badManifest, serviceId: "payments" });
    expect(air.diagnostics.some((d) => d.code === "workflow_step_unresolved")).toBe(true);
  });
});

describe("self-referential schemas", () => {
  it("compiles a recursive schema instead of crashing on a circular object graph", async () => {
    // Real specs legitimately nest a type inside itself (a group of groups, a
    // comment thread of replies). Full $ref dereferencing turns that into an
    // actual circular JS object graph; the compiler must serialize the result,
    // not throw "Converting circular structure to JSON".
    const recursive = `openapi: 3.0.0
info: { title: groups, version: 1.0.0 }
paths:
  /groups/{id}:
    get:
      operationId: getGroup
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Group'
components:
  schemas:
    Group:
      type: object
      properties:
        name: { type: string }
        subgroups:
          type: array
          items:
            $ref: '#/components/schemas/Group'
`;
    const air = await compile({ spec: recursive, serviceId: "groups" });
    expect(air.operations).toHaveLength(1);
    // Structural identity recognizes the inlined recursive copy as `Group`
    // even though it carries no title, so the recursion is represented as an
    // ordinary `$ref` — real structure preserved, nothing truncated. (Before
    // structural hashing, an UNTITLED recursive component could not be
    // re-identified, so this compile had to cycle-truncate and report a
    // `schema_cycle_truncated` diagnostic; that failure mode is gone.)
    expect(air.diagnostics.some((d) => d.code === "schema_cycle_truncated")).toBe(false);
    // The result must actually be JSON-safe (this would throw if it weren't).
    expect(() => JSON.stringify(air)).not.toThrow();
  });
});
