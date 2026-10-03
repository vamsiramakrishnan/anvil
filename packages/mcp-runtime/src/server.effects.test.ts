import { type AirDocument, loadAirDocument, Operation } from "@anvil/air";
import type { AuditLine, HttpRequest, Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { buildFleetServer } from "./fleet.js";
import { buildMcpServer } from "./server.js";

/**
 * The effect contract on the MCP serving path (ADR-0030): `_meta.effect` on
 * every operation result, `_meta.idempotency_key` forwarded through the
 * declared carrier, and `_meta.stage` performing the draft form.
 */

function operation(spec: Record<string, unknown>): Operation {
  return Operation.parse({
    displayName: spec.id,
    canonicalName: String(spec.id).replace(/\./g, "_"),
    input: { params: [] },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "none" },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: String(spec.id).replace(/\./g, " ") },
    mcp: { toolName: String(spec.id).replace(/\./g, "_") },
    skill: { intentExamples: [] },
    state: "approved",
    ...spec,
  });
}

const path = (name: string, type = "string") => ({
  name,
  in: "path",
  required: true,
  schema: { type },
});
const fields = (...names: Array<[string, string, boolean?]>) => ({
  contentType: "application/json",
  required: true,
  schema: { type: "object" },
  projection: "fields",
  fields: names.map(([name, type, required]) => ({
    name,
    required: required ?? false,
    schema: { type },
  })),
});

const OPS = [
  operation({
    id: "gh.issues.list",
    sourceRef: { kind: "openapi", path: "/issues", method: "get" },
    effect: { kind: "read", action: "list" },
  }),
  operation({
    id: "gh.comments.create",
    sourceRef: { kind: "openapi", path: "/repos/{owner}/comments", method: "post" },
    effect: {
      kind: "mutation",
      action: "create",
      class: "reversible",
      inverse: {
        operation: "gh.comments.delete",
        arguments: { owner: "request.owner", id: "response.id" },
        deadline: { withinMs: 60_000 },
      },
    },
    input: { params: [path("owner")], body: fields(["body", "string", true]) },
    idempotency: {
      mode: "key_supported",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    output: { schema: { type: "object", properties: { id: { type: "integer" } } } },
  }),
  operation({
    id: "gh.comments.delete",
    sourceRef: { kind: "openapi", path: "/repos/{owner}/comments/{id}", method: "delete" },
    effect: { kind: "mutation", action: "delete", risk: "destructive" },
    input: { params: [path("owner"), path("id", "integer")] },
    confirmation: { required: true },
  }),
  operation({
    id: "gh.releases.create",
    sourceRef: { kind: "openapi", path: "/releases", method: "post" },
    effect: {
      kind: "mutation",
      action: "create",
      class: "irreversible",
      lookup: { operation: "gh.issues.list", by: "id", arguments: {} },
      draft: {
        operation: "gh.releases.create",
        arguments: { tag: "request.tag", draft: { const: true } },
        handle: "response.id",
        promote: {
          operation: "gh.releases.update",
          arguments: { id: "response.id", draft: { const: false } },
        },
      },
    },
    input: { body: fields(["tag", "string", true], ["draft", "boolean"]) },
    confirmation: { required: true },
  }),
  operation({
    id: "gh.releases.update",
    sourceRef: { kind: "openapi", path: "/releases/{id}", method: "patch" },
    effect: { kind: "mutation", action: "update" },
    input: { params: [path("id", "integer")], body: fields(["draft", "boolean"]) },
  }),
  operation({
    id: "gh.posts.create",
    sourceRef: { kind: "openapi", path: "/posts", method: "post" },
    effect: {
      kind: "mutation",
      class: "irreversible",
      draft: {
        operation: "gh.posts.draft",
        arguments: { title: "request.title" },
        handle: "response.id",
        promote: { operation: "gh.posts.draft", arguments: {} },
      },
    },
    input: { body: fields(["title", "string"]) },
  }),
  operation({
    id: "gh.posts.draft",
    sourceRef: { kind: "openapi", path: "/posts/drafts", method: "post" },
    effect: { kind: "mutation" },
    input: { body: fields(["title", "string"]) },
    state: "review_required",
  }),
  operation({
    id: "gh.notes.create",
    sourceRef: { kind: "openapi", path: "/notes", method: "post" },
    effect: {
      kind: "mutation",
      class: "irreversible",
      draft: {
        operation: "gh.notes.create",
        arguments: { title: "request.title", draft: { const: true } },
        handle: "response.id",
        promote: { operation: "gh.notes.create", arguments: {} },
      },
    },
    input: { body: fields(["title", "string"], ["draft", "boolean"]) },
  }),
  operation({
    id: "gh.memos.create",
    sourceRef: { kind: "openapi", path: "/memos", method: "post" },
    effect: {
      kind: "mutation",
      class: "irreversible",
      draft: {
        operation: "gh.memos.create",
        // A hand-written AIR document the compiler never checked: a number
        // mapped into a string field.
        arguments: { title: { const: 1 }, draft: { const: true } },
        handle: "response.id",
        promote: { operation: "gh.memos.create", arguments: {} },
      },
    },
    input: { body: fields(["title", "string", true], ["draft", "boolean"]) },
  }),
  operation({
    id: "gh.issues.send",
    sourceRef: { kind: "openapi", path: "/issues/send", method: "post" },
    effect: { kind: "mutation", action: "send" },
  }),
];

function air(): AirDocument {
  return loadAirDocument({
    service: { id: "gh", version: "1.0.0", source: { kind: "openapi" } },
    operations: OPS,
  });
}

/** A fake upstream: records every request and answers like a tiny GitHub. */
function upstream() {
  const requests: HttpRequest[] = [];
  const transport: Transport = {
    send: async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      const body = typeof request.body === "string" && request.body ? JSON.parse(request.body) : {};
      if (url.pathname.endsWith("/comments") && request.method === "POST") {
        return { status: 201, headers: {}, body: JSON.stringify({ id: 9, body: body.body }) };
      }
      if (url.pathname === "/releases") {
        return { status: 201, headers: {}, body: JSON.stringify({ id: 500, ...body }) };
      }
      if (url.pathname.startsWith("/releases/")) {
        return { status: 200, headers: {}, body: JSON.stringify({ id: 500, ...body }) };
      }
      if (request.method === "DELETE") return { status: 204, headers: {}, body: "" };
      return { status: 200, headers: {}, body: "[]" };
    },
  };
  return { requests, transport };
}

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "effects-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function serve() {
  const fake = upstream();
  const audit: AuditLine[] = [];
  const server = buildMcpServer(air(), {
    contextFor: () => ({
      transport: fake.transport,
      serviceId: "gh",
      baseUrl: "http://upstream.test",
      allowedHosts: ["upstream.test"],
      audit: (line) => audit.push(line),
    }),
  });
  return { server, ...fake, audit };
}

type Result = { isError?: boolean; _meta?: { effect?: Record<string, unknown> } };

describe("_meta.effect on the MCP surface", () => {
  it("reports a reversible call's inverse and forwards the caller's key upstream", async () => {
    const { server, requests, audit } = serve();
    const client = await connect(server);
    const before = Date.now();
    const result = (await client.callTool({
      name: "gh_comments_create",
      arguments: { owner: "octo", body: "hi" },
      _meta: { idempotency_key: "ledger-01" },
    })) as Result;
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    const effect = result._meta?.effect as Record<string, unknown>;
    expect(effect).toMatchObject({
      class: "reversible",
      operation: "gh.comments.create",
      idempotency_key: "ledger-01",
      undo: {
        kind: "inverse",
        operation: "gh.comments.delete",
        tool: "gh_comments_delete",
        arguments: { owner: "octo", id: 9 },
      },
      lookup: null,
    });
    expect(effect.deadline_ms as number).toBeGreaterThanOrEqual(before + 60_000);
    expect(requests[0]?.headers["Idempotency-Key"]).toBe("ledger-01");
    expect(audit[0]).toMatchObject({
      operation: "gh.comments.create",
      effect_class: "reversible",
      ledger_id: "ledger-01",
      staged_for: null,
    });

    // The inverse is an ordinary call: the report's arguments plus the
    // caller's own confirmation.
    const undo = effect.undo as { tool: string; arguments: Record<string, unknown> };
    const undone = (await client.callTool({
      name: undo.tool,
      arguments: { ...undo.arguments, confirm: true },
    })) as Result;
    expect(undone.isError).toBeFalsy();
    expect(requests[1]).toMatchObject({
      method: "DELETE",
      url: "http://upstream.test/repos/octo/comments/9",
    });
    expect(undone._meta?.effect).toMatchObject({ class: "irreversible", undo: null });
    await client.close();
  });

  it("records the ledger id but sends no key for an operation without a carrier", async () => {
    const { server, requests, audit } = serve();
    const client = await connect(server);
    const result = (await client.callTool({
      name: "gh_issues_send",
      arguments: {},
      _meta: { idempotency_key: "ledger-02" },
    })) as Result;
    expect(result.isError).toBeFalsy();
    expect(result._meta?.effect).toMatchObject({
      class: "irreversible",
      idempotency_key: null,
      undo: null,
    });
    expect(Object.keys(requests[0]?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain(
      "idempotency-key",
    );
    expect(audit[0]).toMatchObject({ effect_class: "irreversible", ledger_id: "ledger-02" });
    await client.close();
  });

  it("gives an undeclared read the default class", async () => {
    const { server } = serve();
    const client = await connect(server);
    const result = (await client.callTool({ name: "gh_issues_list", arguments: {} })) as Result;
    expect(result._meta?.effect).toEqual({
      class: "read",
      operation: "gh.issues.list",
      idempotency_key: null,
      undo: null,
      deadline_ms: null,
      lookup: null,
    });
    await client.close();
  });

  it("publishes the declaration in tools/list only where one exists", async () => {
    const { server } = serve();
    const client = await connect(server);
    const tools = (await client.listTools()).tools;
    const meta = (name: string) => tools.find((tool) => tool.name === name)?._meta ?? {};
    expect(meta("gh_comments_create")["anvil/effect_class"]).toBe("reversible");
    expect(meta("gh_comments_create")["anvil/effect_contract"]).toMatchObject({
      inverse: { operation: "gh.comments.delete" },
    });
    expect(meta("gh_issues_send")).not.toHaveProperty("anvil/effect_class");
    await client.close();
  });

  it("refuses two different keys and a malformed _meta before anything is called", async () => {
    const { server, requests } = serve();
    const client = await connect(server);
    const conflict = (await client.callTool({
      name: "gh_comments_create",
      arguments: { owner: "octo", body: "hi", idempotency_key: "a" },
      _meta: { idempotency_key: "b" },
    })) as Result & { content: Array<{ text: string }> };
    expect(conflict.isError).toBe(true);
    expect(JSON.parse(conflict.content[0]?.text ?? "{}").error.details.code).toBe(
      "effect/idempotency_key_conflict",
    );
    const malformed = (await client.callTool({
      name: "gh_comments_create",
      arguments: { owner: "octo", body: "hi" },
      _meta: { stage: "yes" },
    })) as Result & { content: Array<{ text: string }> };
    expect(JSON.parse(malformed.content[0]?.text ?? "{}").error.details.code).toBe(
      "effect/invalid_meta",
    );
    expect(requests).toHaveLength(0);
    await client.close();
  });
});

describe("stage: true", () => {
  it("performs the draft form, returns its handle and promotion, and promote publishes", async () => {
    const { server, requests, audit } = serve();
    const client = await connect(server);
    const staged = (await client.callTool({
      name: "gh_releases_create",
      arguments: { tag: "v1", confirm: true },
      _meta: { stage: true, idempotency_key: "ledger-03" },
    })) as Result;
    expect(staged.isError).toBeFalsy();
    expect(JSON.parse(String(requests[0]?.body))).toEqual({ tag: "v1", draft: true });
    expect(staged._meta?.effect).toMatchObject({
      class: "irreversible",
      operation: "gh.releases.create",
      undo: null,
      staged: {
        draft_operation: "gh.releases.create",
        handle: 500,
        promote: {
          operation: "gh.releases.update",
          tool: "gh_releases_update",
          arguments: { id: 500, draft: false },
        },
        discard: null,
      },
    });
    expect(audit[0]).toMatchObject({
      operation: "gh.releases.create",
      staged_for: "gh.releases.create",
      ledger_id: "ledger-03",
    });
    const stagedReport = staged._meta?.effect?.staged as
      | { promote: { tool: string; arguments: object } }
      | undefined;
    const promote = stagedReport?.promote ?? { tool: "missing", arguments: {} };
    const promoted = (await client.callTool({
      name: promote.tool,
      arguments: promote.arguments as Record<string, unknown>,
    })) as Result;
    expect(promoted.isError).toBeFalsy();
    expect(requests[1]).toMatchObject({
      method: "PATCH",
      url: "http://upstream.test/releases/500",
    });
    expect(JSON.parse(String(requests[1]?.body))).toEqual({ draft: false });
    await client.close();
  });

  it("never falls through to the real effect when there is no draft form", async () => {
    const { server, requests } = serve();
    const client = await connect(server);
    const refused = (await client.callTool({
      name: "gh_comments_create",
      arguments: { owner: "octo", body: "hi" },
      _meta: { stage: true },
    })) as Result & { content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0]?.text ?? "{}").error).toMatchObject({
      code: "unsupported_operation",
      details: { code: "effect/no_draft_form" },
    });
    expect(requests).toHaveLength(0);
    await client.close();
  });
  it("refuses a draft it cannot perform, before anything is called", async () => {
    const { server, requests } = serve();
    const client = await connect(server);
    const detailCode = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({
        name,
        arguments: args,
        _meta: { stage: true },
      })) as Result & { content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      return JSON.parse(result.content[0]?.text ?? "{}").error.details.code;
    };
    // The draft operation is not approved, so this server does not serve it.
    expect(await detailCode("gh_posts_create", { title: "t" })).toBe("effect/draft_unavailable");
    // The draft needs a value the staged call did not give.
    expect(await detailCode("gh_notes_create", {})).toBe("effect/draft_argument_missing");
    // The mapped draft input fails the draft tool's own input schema.
    expect(await detailCode("gh_memos_create", { title: "t" })).toBe("effect/draft_input_invalid");
    expect(requests).toHaveLength(0);
    await client.close();
  });
});

describe("through a fleet", () => {
  it("forwards the effect controls and names follow-ups by their fleet tool names", async () => {
    const fake = upstream();
    const fleet = await buildFleetServer(
      [
        {
          id: "github",
          air: air(),
          options: {
            contextFor: () => ({
              transport: fake.transport,
              serviceId: "gh",
              baseUrl: "http://upstream.test",
              allowedHosts: ["upstream.test"],
            }),
          },
        },
      ],
      { alwaysPrefix: true },
    );
    const client = await connect(fleet.server);
    const result = (await client.callTool({
      name: "github__gh_comments_create",
      arguments: { owner: "octo", body: "hi" },
      _meta: { idempotency_key: "ledger-04", progressToken: 7 },
    })) as Result;
    expect(fake.requests[0]?.headers["Idempotency-Key"]).toBe("ledger-04");
    expect(result._meta?.effect).toMatchObject({
      idempotency_key: "ledger-04",
      undo: { tool: "github__gh_comments_delete" },
    });
    const staged = (await client.callTool({
      name: "github__gh_releases_create",
      arguments: { tag: "v2", confirm: true },
      _meta: { stage: true },
    })) as Result;
    expect(staged._meta?.effect).toMatchObject({
      staged: { promote: { tool: "github__gh_releases_update" } },
      lookup: null,
    });
    await client.close();
    await fleet.close();
  });
});
