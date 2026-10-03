import { describe, expect, it } from "vitest";
import {
  effectClassOf,
  effectContractMeta,
  effectPathInSchema,
  effectUndoSentence,
  operationForwardsIdempotencyKey,
  parseEffectPath,
  resolveEffectArguments,
  resolveEffectDeadline,
  resolveEffectReport,
  resolveStagedReport,
} from "./effect-contract.js";
import { Operation } from "./schema.js";

function op(id: string, effect: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return Operation.parse({
    id,
    canonicalName: id.replace(/\./g, "_"),
    displayName: id,
    sourceRef: { kind: "openapi", path: `/${id}`, method: "post" },
    effect,
    input: { params: [] },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "none" },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: id },
    mcp: { toolName: id.replace(/\./g, "_") },
    skill: { intentExamples: [] },
    state: "approved",
    ...extra,
  });
}

const served = (id: string) => `t_${id.replace(/\./g, "_")}`;

describe("parseEffectPath", () => {
  it("reads roots, properties, and indices", () => {
    expect(parseEffectPath("request.owner")).toEqual({
      root: "request",
      segments: ["owner"],
      optional: false,
    });
    expect(parseEffectPath("response.items[0].id")).toEqual({
      root: "response",
      segments: ["items", 0, "id"],
      optional: false,
    });
    expect(parseEffectPath("idempotency_key")).toEqual({
      root: "idempotency_key",
      segments: [],
      optional: false,
    });
    expect(parseEffectPath("request.name?")).toEqual({
      root: "request",
      segments: ["name"],
      optional: true,
    });
  });

  it("refuses what is not a path", () => {
    for (const bad of [
      "body.id",
      "response",
      "request.",
      "response.items[x]",
      "response.a b",
      "idempotency_key.x",
      "$.response.id",
    ]) {
      expect(parseEffectPath(bad), bad).toHaveProperty("error");
    }
  });
});

describe("effectClassOf", () => {
  it("defaults a read to read and anything else to irreversible", () => {
    expect(effectClassOf(op("s.list", { kind: "read" }))).toBe("read");
    expect(effectClassOf(op("s.create", { kind: "mutation", reversible: true }))).toBe(
      "irreversible",
    );
    expect(effectClassOf(op("s.create", { kind: "mutation", class: "reversible" }))).toBe(
      "reversible",
    );
  });
});

describe("resolveEffectArguments", () => {
  const scope = {
    request: { owner: "octo", nested: { list: [{ id: 7 }] } },
    response: { id: 42, gone: null },
    idempotencyKey: "k-1",
  };

  it("resolves paths and literals into concrete arguments", () => {
    expect(
      resolveEffectArguments(
        {
          owner: "request.owner",
          comment_id: "response.id",
          first: "request.nested.list[0].id",
          key: "idempotency_key",
          state: { const: "closed" },
        },
        scope,
      ),
    ).toEqual({
      ok: true,
      arguments: { owner: "octo", comment_id: 42, first: 7, key: "k-1", state: "closed" },
    });
  });

  it("is all or nothing: a path that names nothing (or null) makes the call unavailable", () => {
    expect(
      resolveEffectArguments({ owner: "request.owner", id: "response.missing" }, scope),
    ).toEqual({
      ok: false,
      argument: "id",
      source: "response.missing",
    });
    expect(resolveEffectArguments({ id: "response.gone" }, scope)).toMatchObject({ ok: false });
    // An own-property check, not a prototype walk.
    expect(resolveEffectArguments({ id: "request.toString" }, scope)).toMatchObject({ ok: false });
  });

  it("leaves an optional argument out instead", () => {
    expect(
      resolveEffectArguments({ owner: "request.owner", name: "request.name?" }, scope),
    ).toEqual({ ok: true, arguments: { owner: "octo" } });
  });
});

describe("resolveEffectDeadline", () => {
  it("counts withinMs from the answer, reads at from the response, and says when it cannot", () => {
    expect(resolveEffectDeadline(undefined, {}, 1000)).toBeNull();
    expect(resolveEffectDeadline({ withinMs: 500 }, {}, 1000)).toBe(1500);
    expect(
      resolveEffectDeadline(
        { at: "response.expires" },
        { response: { expires: "2026-10-03T12:00:00Z" } },
        0,
      ),
    ).toBe(Date.parse("2026-10-03T12:00:00Z"));
    expect(
      resolveEffectDeadline({ at: "response.expires" }, { response: { expires: 99 } }, 0),
    ).toBe(99);
    expect(
      resolveEffectDeadline({ at: "response.expires" }, { response: { expires: "soon" } }, 0),
    ).toBeUndefined();
    expect(resolveEffectDeadline({ at: "response.expires" }, { response: {} }, 0)).toBeUndefined();
  });
});

describe("effectPathInSchema", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "integer" },
      items: { type: "array", items: { $ref: "#/components/schemas/Item" } },
      open: { type: "object" },
      map: { type: "object", properties: { known: {} }, additionalProperties: { type: "string" } },
      either: { oneOf: [{ type: "object", properties: { a: {} } }, { type: "string" }] },
    },
  };
  const defs = { Item: { type: "object", properties: { id: { type: "string" } } } };

  it("finds declared paths, through $ref and branches", () => {
    expect(effectPathInSchema(schema, ["id"], defs)).toBe("ok");
    expect(effectPathInSchema(schema, ["items", 0, "id"], defs)).toBe("ok");
    expect(effectPathInSchema(schema, ["either", "a"], defs)).toBe("ok");
  });

  it("is certain only when the schema is", () => {
    expect(effectPathInSchema(schema, ["nope"], defs)).toBe("missing");
    expect(effectPathInSchema(schema, ["id", "deeper"], defs)).toBe("missing");
    expect(effectPathInSchema(schema, ["open", "anything"], defs)).toBe("unverifiable");
    expect(effectPathInSchema(schema, ["map", "anything"], defs)).toBe("unverifiable");
    expect(effectPathInSchema(schema, ["items", 0, "name"], defs)).toBe("missing");
    expect(effectPathInSchema(undefined, ["id"], defs)).toBe("unverifiable");
    expect(effectPathInSchema({ $ref: "#/components/schemas/Gone" }, ["id"], defs)).toBe(
      "unverifiable",
    );
  });
});

describe("resolveEffectReport", () => {
  const comment = op("gh.comments.create", {
    kind: "mutation",
    class: "reversible",
    inverse: {
      operation: "gh.comments.delete",
      arguments: { owner: "request.owner", comment_id: "response.id" },
      deadline: { withinMs: 60_000 },
    },
    compensate: {
      operation: "gh.comments.update",
      arguments: { comment_id: "response.id", body: { const: "[retracted]" } },
    },
  });
  const issue = op("gh.issues.create", {
    kind: "mutation",
    class: "compensable",
    compensate: {
      operation: "gh.issues.update",
      arguments: { number: "response.number", state: { const: "closed" } },
    },
    lookup: {
      operation: "gh.issues.find",
      by: "idempotency_key",
      arguments: { key: "idempotency_key" },
    },
  });

  it("names the inverse with concrete arguments, its deadline, and the key", () => {
    const report = resolveEffectReport({
      op: comment,
      request: { owner: "octo", body: "hi" },
      response: { id: 9 },
      idempotencyKey: "ledger-1",
      answeredAt: 1_000,
      toolFor: served,
      succeeded: true,
    });
    expect(report).toEqual({
      class: "reversible",
      operation: "gh.comments.create",
      idempotency_key: "ledger-1",
      undo: {
        kind: "inverse",
        operation: "gh.comments.delete",
        tool: "t_gh_comments_delete",
        arguments: { owner: "octo", comment_id: 9 },
      },
      deadline_ms: 61_000,
      compensate: {
        operation: "gh.comments.update",
        tool: "t_gh_comments_update",
        arguments: { comment_id: 9, body: "[retracted]" },
        deadline_ms: null,
      },
      lookup: null,
    });
  });

  it("names a compensation as the undo of a compensable effect, and its lookup", () => {
    const report = resolveEffectReport({
      op: issue,
      request: {},
      response: { number: 3 },
      idempotencyKey: "k",
      answeredAt: 0,
      toolFor: served,
      succeeded: true,
    });
    expect(report.undo).toEqual({
      kind: "compensate",
      operation: "gh.issues.update",
      tool: "t_gh_issues_update",
      arguments: { number: 3, state: "closed" },
    });
    expect(report.lookup).toEqual({
      by: "idempotency_key",
      operation: "gh.issues.find",
      tool: "t_gh_issues_find",
      arguments: { key: "k" },
    });
  });

  it("offers no undo for a failed call, but still the lookup", () => {
    const report = resolveEffectReport({
      op: issue,
      request: {},
      idempotencyKey: "k",
      answeredAt: 0,
      toolFor: served,
      succeeded: false,
    });
    expect(report.undo).toBeNull();
    expect(report.lookup?.arguments).toEqual({ key: "k" });
  });

  it("says why an undo is unavailable instead of offering a broken one", () => {
    const missing = resolveEffectReport({
      op: comment,
      request: { owner: "octo" },
      response: {},
      answeredAt: 0,
      toolFor: served,
      succeeded: true,
    });
    expect(missing.undo).toBeNull();
    expect(missing.undo_unavailable).toContain("comment_id");
    const unserved = resolveEffectReport({
      op: comment,
      request: { owner: "octo" },
      response: { id: 1 },
      answeredAt: 0,
      toolFor: () => undefined,
      succeeded: true,
    });
    expect(unserved.undo).toBeNull();
    expect(unserved.undo_unavailable).toContain("not served");
  });

  it("reports undeclared operations by their default class with no undo", () => {
    const read = resolveEffectReport({
      op: op("gh.issues.list", { kind: "read" }),
      request: {},
      response: [],
      answeredAt: 0,
      toolFor: served,
      succeeded: true,
    });
    expect(read).toEqual({
      class: "read",
      operation: "gh.issues.list",
      idempotency_key: null,
      undo: null,
      deadline_ms: null,
      lookup: null,
    });
    const write = resolveEffectReport({
      op: op("gh.thing.send", { kind: "mutation" }),
      request: {},
      response: {},
      answeredAt: 0,
      toolFor: served,
      succeeded: true,
    });
    expect(write.class).toBe("irreversible");
    expect(write.undo).toBeNull();
    expect(write.undo_unavailable).toBeUndefined();
  });
});

describe("resolveStagedReport", () => {
  const release = op("gh.releases.create", {
    kind: "mutation",
    class: "irreversible",
    draft: {
      operation: "gh.releases.create",
      arguments: { tag: "request.tag", draft: { const: true } },
      handle: "response.id",
      promote: {
        operation: "gh.releases.update",
        arguments: { id: "response.id", draft: { const: false } },
      },
      discard: { operation: "gh.releases.delete", arguments: { id: "response.id" } },
    },
  });

  it("returns the handle, the promotion, and the discard; no undo", () => {
    const report = resolveStagedReport({
      op: release,
      request: { tag: "v1" },
      draftResponse: { id: 500 },
      toolFor: served,
    });
    expect(report.class).toBe("irreversible");
    expect(report.undo).toBeNull();
    expect(report.staged).toEqual({
      draft_operation: "gh.releases.create",
      handle: 500,
      promote: {
        operation: "gh.releases.update",
        tool: "t_gh_releases_update",
        arguments: { id: 500, draft: false },
      },
      discard: {
        operation: "gh.releases.delete",
        tool: "t_gh_releases_delete",
        arguments: { id: 500 },
      },
    });
  });

  it("says when the promotion cannot be resolved", () => {
    const report = resolveStagedReport({
      op: release,
      request: { tag: "v1" },
      draftResponse: {},
      toolFor: served,
    });
    expect(report.staged?.promote).toBeNull();
    expect(report.staged?.unavailable).toContain("promote");
  });
});

describe("declarations on the tool surface and in prose", () => {
  it("publishes only what is declared", () => {
    expect(effectContractMeta(op("s.x", { kind: "mutation" }))).toBeUndefined();
    expect(effectContractMeta(op("s.x", { kind: "mutation", class: "irreversible" }))).toEqual({
      class: "irreversible",
    });
  });

  it("says whether an action can be undone", () => {
    const reversible = op("s.c", {
      kind: "mutation",
      class: "reversible",
      inverse: { operation: "s.d", deadline: { withinMs: 3_600_000 } },
    });
    expect(effectUndoSentence(reversible)).toBe(
      "This action can be undone with `s.d` within 1 hour.",
    );
    expect(effectUndoSentence(op("s.x", { kind: "mutation" }))).toBe(
      "This action cannot be undone.",
    );
    expect(
      effectUndoSentence(
        op("s.i", { kind: "mutation", class: "compensable", compensate: { operation: "s.close" } }),
      ),
    ).toContain("can be compensated with `s.close`");
  });

  it("forwards a key only through a declared carrier", () => {
    expect(operationForwardsIdempotencyKey(op("s.x", { kind: "mutation" }))).toBe(false);
    expect(
      operationForwardsIdempotencyKey(
        op(
          "s.x",
          { kind: "mutation" },
          { idempotency: { mode: "key_supported", mechanism: "header", key: "Idempotency-Key" } },
        ),
      ),
    ).toBe(true);
  });
});
