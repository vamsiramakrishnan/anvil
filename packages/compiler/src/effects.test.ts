import { readFileSync } from "node:fs";
import type { AirDocument, Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";

/**
 * The effect contract's compiler side (ADR-0030): a manifest `effect:` block
 * lands on AIR's `effect`, references are pinned to AIR ids, and every
 * declaration is checked against the operations and schemas it names.
 */

const SPEC = readFileSync(
  new URL("../../../examples/github-mini/openapi.yaml", import.meta.url),
  "utf8",
);
const MANIFEST = readFileSync(
  new URL("../../../examples/github-mini/anvil.yaml", import.meta.url),
  "utf8",
);

const NAMES = `
service: { name: github }
operations:
  listIssues: { name: { resource: issues, verb: list } }
  getIssue: { name: { resource: issues, verb: get } }
  createIssue: { name: { resource: issues, verb: create } }
  updateIssue: { name: { resource: issues, verb: update } }
  listIssueComments: { name: { resource: comments, verb: list } }
  deleteIssueComment: { name: { resource: comments, verb: delete } }
  createRelease: { name: { resource: releases, verb: create } }
  updateRelease: { name: { resource: releases, verb: update } }
  deleteRelease: { name: { resource: releases, verb: delete } }
  getReleaseByTag: { name: { resource: releases, verb: get } }
`;

/** Compile the fixture with one extra manifest entry for `createIssueComment`. */
async function withComment(entry: string): Promise<AirDocument> {
  return compile({
    spec: SPEC,
    manifest: `${NAMES}  createIssueComment:\n    name: { resource: comments, verb: create }\n${entry}`,
  });
}

function opOf(air: AirDocument, id: string): Operation {
  const found = air.operations.find((op) => op.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

function effectCodes(air: AirDocument): string[] {
  return air.diagnostics
    .filter((d) => d.code.startsWith("effect/") && d.level === "error")
    .map((d) => d.code)
    .sort();
}

describe("the effect contract in the compiler", () => {
  it("compiles the fixture's declarations, pinning references to AIR ids", async () => {
    const air = await compile({ spec: SPEC, manifest: MANIFEST });
    expect(effectCodes(air)).toEqual([]);
    const comment = opOf(air, "github.comments.create");
    expect(comment.effect.class).toBe("reversible");
    expect(comment.effect.reversible).toBe(true);
    expect(comment.effect.inverse).toEqual({
      operation: "github.comments.delete",
      arguments: { owner: "request.owner", repo: "request.repo", comment_id: "response.id" },
    });
    const issue = opOf(air, "github.issues.create");
    expect(issue.effect.class).toBe("compensable");
    expect(issue.effect.compensate?.operation).toBe("github.issues.update");
    const release = opOf(air, "github.releases.create");
    expect(release.effect.class).toBe("irreversible");
    expect(release.effect.reversible).toBe(false);
    expect(release.effect.draft?.operation).toBe("github.releases.create");
    expect(release.effect.draft?.promote.operation).toBe("github.releases.update");
    expect(release.effect.lookup?.operation).toBe("github.tags.get");
  });

  it("leaves undeclared operations without a class (the default applies at serve time)", async () => {
    const air = await compile({ spec: SPEC, manifest: MANIFEST });
    const update = opOf(air, "github.issues.update");
    expect(update.effect.class).toBeUndefined();
    expect(update.effect.inverse).toBeUndefined();
  });

  it("checks an inverse's mapping against both schemas", async () => {
    const air = await withComment(`    effect:
      class: reversible
      inverse:
        operation: deleteIssueComment
        arguments: { owner: request.owner, repo: request.repo, comment_id: response.id }
        deadline: { within_ms: 60000 }
`);
    expect(effectCodes(air)).toEqual([]);
    expect(opOf(air, "github.comments.create").effect.inverse?.deadline).toEqual({
      withinMs: 60000,
    });
  });

  const bad: Array<[string, string, string[]]> = [
    [
      "a reversible operation without an inverse",
      "    effect: { class: reversible }\n",
      ["effect/reversible_without_inverse"],
    ],
    [
      "an inverse naming no operation",
      "    effect:\n      class: reversible\n      inverse: { operation: nukeComment, arguments: {} }\n",
      ["effect/operation_missing"],
    ],
    [
      "an inverse that is a read",
      "    effect:\n      class: reversible\n      inverse: { operation: listIssueComments, arguments: { owner: request.owner, repo: request.repo, issue_number: request.issue_number } }\n",
      ["effect/follow_up_is_read"],
    ],
    [
      "a mapping that misses a required argument and names an unknown one",
      "    effect:\n      class: reversible\n      inverse: { operation: deleteIssueComment, arguments: { owner: request.owner, repo: request.repo, id: response.id } }\n",
      ["effect/mapping_missing_required", "effect/mapping_unknown_argument"],
    ],
    [
      "a path the response schema does not declare",
      "    effect:\n      class: reversible\n      inverse: { operation: deleteIssueComment, arguments: { owner: request.owner, repo: request.repo, comment_id: response.comment.id } }\n",
      ["effect/path_unresolved"],
    ],
    [
      "a path the request schema does not declare",
      "    effect:\n      class: reversible\n      inverse: { operation: deleteIssueComment, arguments: { owner: request.organisation, repo: request.repo, comment_id: response.id } }\n",
      ["effect/path_unresolved"],
    ],
    [
      "a malformed path",
      "    effect:\n      class: reversible\n      inverse: { operation: deleteIssueComment, arguments: { owner: 'body.owner', repo: request.repo, comment_id: response.id } }\n",
      ["effect/path_invalid"],
    ],
    [
      "a mapping that sets the inverse's confirmation",
      "    effect:\n      class: reversible\n      inverse: { operation: deleteIssueComment, arguments: { owner: request.owner, repo: request.repo, comment_id: response.id, confirm: { const: true } } }\n",
      ["effect/mapping_sets_safety_control"],
    ],
    [
      "an inverse on an irreversible effect",
      "    effect:\n      class: irreversible\n      inverse: { operation: deleteIssueComment, arguments: { owner: request.owner, repo: request.repo, comment_id: response.id } }\n",
      ["effect/inverse_on_non_reversible"],
    ],
    [
      "a read class on a mutation",
      "    effect: { class: read }\n",
      ["effect/read_class_on_mutation"],
    ],
    [
      "a class that contradicts reversible",
      "    reversible: false\n    effect:\n      class: reversible\n      inverse: { operation: deleteIssueComment, arguments: { owner: request.owner, repo: request.repo, comment_id: response.id } }\n",
      ["effect/class_conflicts_reversible"],
    ],
    [
      "a compensable class with nothing to compensate",
      "    effect: { class: compensable }\n",
      ["effect/compensable_without_compensate"],
    ],
    [
      "a lookup by key on an operation that sends no key",
      "    effect:\n      class: irreversible\n      lookup: { operation: listIssueComments, by: idempotency_key, arguments: { owner: request.owner, repo: request.repo, issue_number: request.issue_number } }\n",
      ["effect/lookup_key_unused", "effect/lookup_without_idempotency_key"],
    ],
    [
      "a lookup that reads the lost response",
      "    idempotency: { strategy: key_supported, key_location: header, header: Idempotency-Key }\n    effect:\n      class: irreversible\n      lookup: { operation: getIssue, by: idempotency_key, arguments: { owner: request.owner, repo: idempotency_key, issue_number: response.id } }\n",
      ["effect/path_root_not_allowed"],
    ],
    [
      "a lookup that is a mutation",
      "    effect:\n      class: irreversible\n      lookup: { operation: deleteIssueComment, by: id, arguments: { owner: request.owner, repo: request.repo, comment_id: request.issue_number } }\n",
      ["effect/lookup_not_read"],
    ],
    [
      "a deadline with both forms",
      "    effect:\n      class: reversible\n      inverse:\n        operation: deleteIssueComment\n        arguments: { owner: request.owner, repo: request.repo, comment_id: response.id }\n        deadline: { within_ms: 5, at: response.id }\n",
      ["effect/deadline_shape"],
    ],
    [
      "a draft whose handle is not a response path",
      "    effect:\n      class: irreversible\n      draft:\n        operation: createIssueComment\n        arguments: { owner: request.owner, repo: request.repo, issue_number: request.issue_number, body: request.body }\n        handle: request.body\n        promote: { operation: deleteIssueComment, arguments: { owner: request.owner, repo: request.repo, comment_id: response.id } }\n",
      ["effect/draft_handle"],
    ],
    [
      "a required argument fed from an optional path",
      "    effect:\n      class: reversible\n      inverse: { operation: deleteIssueComment, arguments: { owner: request.owner, repo: request.repo, comment_id: response.id? } }\n",
      ["effect/mapping_required_optional"],
    ],
  ];

  for (const [name, entry, codes] of bad) {
    it(`refuses ${name}, and serves the operation with no undo`, async () => {
      const air = await withComment(entry);
      expect(effectCodes(air)).toEqual(codes);
      const comment = opOf(air, "github.comments.create");
      expect(comment.effect.class).toBe("irreversible");
      expect(comment.effect.reversible).toBe(false);
      expect(comment.effect.inverse).toBeUndefined();
      expect(comment.effect.lookup).toBeUndefined();
      expect(comment.effect.draft).toBeUndefined();
      expect(comment.reviewNotes.some((note) => note.startsWith("Effect contract rejected"))).toBe(
        true,
      );
    });
  }

  it("refuses a class on a read", async () => {
    const air = await compile({
      spec: SPEC,
      manifest: `${NAMES}  listPulls:\n    effect: { class: irreversible }\n`,
    });
    expect(effectCodes(air)).toEqual(["effect/class_on_read"]);
    expect(opOf(air, "github.pulls.list").effect.class).toBe("read");
  });

  it("warns when a follow-up is not approved", async () => {
    const air = await withComment(`    state: approved
    effect:
      class: reversible
      inverse:
        operation: deleteIssueComment
        arguments: { owner: request.owner, repo: request.repo, comment_id: response.id }
`);
    expect(effectCodes(air)).toEqual([]);
    expect(air.diagnostics.map((d) => d.code)).toContain("effect/operation_not_approved");
  });

  it("refuses an unknown key in the manifest's effect block", async () => {
    await expect(withComment("    effect: { class: reversible, undo: x }\n")).rejects.toThrow();
  });
});
