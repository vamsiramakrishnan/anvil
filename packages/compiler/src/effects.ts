import {
  type Diagnostic,
  type EffectArgumentMapping,
  type EffectDeadline,
  type EffectPathRoot,
  effectClassOf,
  effectPathInSchema,
  idempotencyModeUsesCarrier,
  type JsonSchema,
  type Operation,
  operationForwardsIdempotencyKey,
  operationInputSchema,
  operationSafetyInputKeys,
  parseEffectPath,
} from "@anvil/air";
import { z } from "zod";

/**
 * The effect contract (ADR-0030): the manifest's `effect:` block, its
 * application onto AIR's `effect`, and the cross-operation checks that make a
 * declared undo something a caller can actually perform.
 *
 * ```yaml
 * operations:
 *   createIssueComment:
 *     effect:
 *       class: reversible
 *       inverse:
 *         operation: deleteIssueComment
 *         arguments: { owner: request.owner, repo: request.repo, comment_id: response.id }
 *         deadline: { within_ms: 86400000 }
 *       lookup:
 *         operation: listIssueComments
 *         by: idempotency_key
 *         arguments: { owner: request.owner, repo: request.repo, idempotency_key: idempotency_key }
 * ```
 *
 * Operation references take any spelling the manifest's own keys take (the
 * source operationId, the canonical name, or the AIR id) and are rewritten to
 * AIR ids before validation (`resolveEffectReferences`).
 */

const ManifestEffectArguments = z.record(
  z.string().min(1),
  z.union([z.string().min(1), z.strictObject({ const: z.unknown() })]),
);

const ManifestEffectDeadline = z.strictObject({
  /** The undo works for this long after the original call answered. */
  within_ms: z.number().int().positive().optional(),
  /** A `response.*` path to the time (ISO-8601 or epoch ms) the undo stops working. */
  at: z.string().min(1).optional(),
});

const ManifestEffectUndo = z.strictObject({
  operation: z.string().min(1),
  arguments: ManifestEffectArguments.optional(),
  deadline: ManifestEffectDeadline.optional(),
});

const ManifestEffectFollowUp = z.strictObject({
  operation: z.string().min(1),
  arguments: ManifestEffectArguments.optional(),
});

export const ManifestEffect = z.strictObject({
  class: z.enum(["read", "reversible", "compensable", "irreversible"]).optional(),
  inverse: ManifestEffectUndo.optional(),
  compensate: ManifestEffectUndo.optional(),
  lookup: z
    .strictObject({
      operation: z.string().min(1),
      by: z.enum(["idempotency_key", "id"]),
      arguments: ManifestEffectArguments.optional(),
    })
    .optional(),
  draft: z
    .strictObject({
      operation: z.string().min(1),
      arguments: ManifestEffectArguments.optional(),
      handle: z.string().min(1),
      promote: ManifestEffectFollowUp,
      discard: ManifestEffectFollowUp.optional(),
    })
    .optional(),
});
export type ManifestEffect = z.infer<typeof ManifestEffect>;

function deadlineToAir(
  deadline: z.infer<typeof ManifestEffectDeadline> | undefined,
): EffectDeadline | undefined {
  if (!deadline) return undefined;
  return {
    ...(deadline.within_ms !== undefined ? { withinMs: deadline.within_ms } : {}),
    ...(deadline.at !== undefined ? { at: deadline.at } : {}),
  };
}

function undoToAir(undo: z.infer<typeof ManifestEffectUndo> | undefined) {
  if (!undo) return undefined;
  const deadline = deadlineToAir(undo.deadline);
  return {
    operation: undo.operation,
    arguments: { ...(undo.arguments ?? {}) } as EffectArgumentMapping,
    ...(deadline ? { deadline } : {}),
  };
}

/**
 * Write a manifest `effect:` block onto an operation. Declared pieces replace
 * what was there; the descriptive `reversible` flag follows the class unless
 * the same entry sets it (a contradiction is the validator's to report).
 */
export function applyEffectPatch(
  op: Operation,
  patch: ManifestEffect,
  reversibleSetExplicitly: boolean,
): void {
  if (patch.class) {
    op.effect.class = patch.class;
    if (!reversibleSetExplicitly) {
      op.effect.reversible = patch.class === "read" || patch.class === "reversible";
    }
  }
  const inverse = undoToAir(patch.inverse);
  if (inverse) op.effect.inverse = inverse;
  const compensate = undoToAir(patch.compensate);
  if (compensate) op.effect.compensate = compensate;
  if (patch.lookup) {
    op.effect.lookup = {
      operation: patch.lookup.operation,
      by: patch.lookup.by,
      arguments: { ...(patch.lookup.arguments ?? {}) } as EffectArgumentMapping,
    };
  }
  if (patch.draft) {
    op.effect.draft = {
      operation: patch.draft.operation,
      arguments: { ...(patch.draft.arguments ?? {}) } as EffectArgumentMapping,
      handle: patch.draft.handle,
      promote: followUpToAir(patch.draft.promote),
      ...(patch.draft.discard ? { discard: followUpToAir(patch.draft.discard) } : {}),
    };
  }
}

function followUpToAir(followUp: z.infer<typeof ManifestEffectFollowUp>) {
  return {
    operation: followUp.operation,
    arguments: { ...(followUp.arguments ?? {}) } as EffectArgumentMapping,
  };
}

function matchesKey(op: Operation, key: string): boolean {
  return op.id === key || op.canonicalName === key || op.sourceRef.operationId === key;
}

/**
 * Rewrite every operation reference in every effect contract to an AIR id.
 * A reference that names no operation, or several, is left as written; the
 * validator reports it.
 */
export function resolveEffectReferences(operations: Operation[]): void {
  const resolve = (ref: string): string => {
    const exact = operations.find((op) => op.id === ref);
    if (exact) return exact.id;
    const matches = operations.filter((op) => matchesKey(op, ref));
    return matches.length === 1 ? (matches[0] as Operation).id : ref;
  };
  for (const op of operations) {
    const e = op.effect;
    if (e.inverse) e.inverse.operation = resolve(e.inverse.operation);
    if (e.compensate) e.compensate.operation = resolve(e.compensate.operation);
    if (e.lookup) e.lookup.operation = resolve(e.lookup.operation);
    if (e.draft) {
      e.draft.operation = resolve(e.draft.operation);
      e.draft.promote.operation = resolve(e.draft.promote.operation);
      if (e.draft.discard) e.draft.discard.operation = resolve(e.draft.discard.operation);
    }
  }
}

interface MappingContext {
  /** Where in the contract this mapping sits, for messages (`inverse`, `draft.promote`, ...). */
  where: string;
  target: Operation;
  mapping: EffectArgumentMapping;
  /** The roots this mapping may read. */
  roots: readonly EffectPathRoot[];
  /** Schema of `request.*` (the original call's input). */
  request: JsonSchema | undefined;
  /** Schema of `response.*` (the original call's, or the draft's, answer). */
  response: JsonSchema | undefined;
}

/**
 * Check every declared effect contract against the operations it names and
 * their schemas. An operation whose contract has an error keeps a safe
 * contract instead: its follow-up declarations are dropped, so it serves as
 * `irreversible` (or `read`) with no undo, never with an undo that cannot run.
 */
export function validateEffectContracts(
  operations: Operation[],
  schemas: Record<string, JsonSchema> = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byId = new Map(operations.map((op) => [op.id, op]));
  for (const op of operations) {
    const e = op.effect;
    if (!e.class && !e.inverse && !e.compensate && !e.lookup && !e.draft) continue;
    const errors: string[] = [];
    const flag = (level: Diagnostic["level"], code: string, message: string) => {
      diagnostics.push({ level, code, message, operationId: op.id });
      if (level === "error") errors.push(message);
    };
    const effectClass = effectClassOf(op);
    const inputSchema = op.input.schema ?? operationInputSchema(op);
    const outputSchema = op.output.schema;

    if (e.kind === "read" && effectClass !== "read") {
      flag(
        "error",
        "effect/class_on_read",
        `Operation '${op.id}' is a read but declares effect class '${effectClass}'.`,
      );
    }
    if (e.kind === "mutation" && effectClass === "read") {
      flag(
        "error",
        "effect/read_class_on_mutation",
        `Operation '${op.id}' is a mutation and cannot declare effect class 'read'; a mutation that changes nothing should be reclassified with side_effect: read.`,
      );
    }
    if (e.class && e.reversible !== (e.class === "read" || e.class === "reversible")) {
      flag(
        "error",
        "effect/class_conflicts_reversible",
        `Operation '${op.id}' declares effect class '${e.class}' but reversible: ${e.reversible}.`,
      );
    }
    if (effectClass === "reversible" && !e.inverse) {
      flag(
        "error",
        "effect/reversible_without_inverse",
        `Operation '${op.id}' is declared reversible but names no inverse operation.`,
      );
    }
    if (effectClass === "compensable" && !e.compensate) {
      flag(
        "error",
        "effect/compensable_without_compensate",
        `Operation '${op.id}' is declared compensable but names no compensating operation.`,
      );
    }
    if (e.inverse && effectClass !== "reversible") {
      flag(
        "error",
        "effect/inverse_on_non_reversible",
        `Operation '${op.id}' names an inverse but its effect class is '${effectClass}'; only a reversible effect has a true inverse.`,
      );
    }
    if (e.compensate && effectClass !== "compensable" && effectClass !== "reversible") {
      flag(
        "error",
        "effect/compensate_on_class",
        `Operation '${op.id}' names a compensation but its effect class is '${effectClass}'.`,
      );
    }
    if (e.lookup && effectClass === "read") {
      flag(
        "error",
        "effect/lookup_on_read",
        `Operation '${op.id}' is a read; there is no effect to look up.`,
      );
    }
    if (e.draft && effectClass === "read") {
      flag(
        "error",
        "effect/draft_on_read",
        `Operation '${op.id}' is a read; it has no draft form.`,
      );
    }

    const target = (
      where: string,
      ref: string,
      want: "mutation" | "read",
    ): Operation | undefined => {
      const found = byId.get(ref);
      if (!found) {
        flag(
          "error",
          "effect/operation_missing",
          `Operation '${op.id}' ${where} names '${ref}', which is not an operation of this service.`,
        );
        return undefined;
      }
      // A draft may be the operation itself called with a draft flag (a
      // release created with draft: true); nothing else may name itself.
      if (found.id === op.id && where !== "draft") {
        flag(
          "error",
          "effect/operation_self",
          `Operation '${op.id}' ${where} names the operation itself.`,
        );
        return undefined;
      }
      if (found.effect.kind !== want) {
        flag(
          "error",
          want === "read" ? "effect/lookup_not_read" : "effect/follow_up_is_read",
          `Operation '${op.id}' ${where} names '${found.id}', which is a ${found.effect.kind}; it must be a ${want}.`,
        );
      }
      if (op.state === "approved" && found.state !== "approved") {
        flag(
          "warning",
          "effect/operation_not_approved",
          `Operation '${op.id}' ${where} names '${found.id}', which is not approved: callers will be refused it until it is.`,
        );
      }
      return found;
    };

    const checkMapping = (ctx: MappingContext) => {
      const targetSchema = ctx.target.input.schema ?? operationInputSchema(ctx.target);
      const properties = (targetSchema.properties ?? {}) as Record<string, JsonSchema>;
      for (const [argument, source] of Object.entries(ctx.mapping)) {
        if (isSafetyControl(ctx.target, argument)) {
          flag(
            "error",
            "effect/mapping_sets_safety_control",
            `Operation '${op.id}' ${ctx.where} maps '${argument}', a safety control of '${ctx.target.id}'; the caller decides confirmation and keys, never the contract.`,
          );
          continue;
        }
        if (!Object.hasOwn(properties, argument)) {
          flag(
            "error",
            "effect/mapping_unknown_argument",
            `Operation '${op.id}' ${ctx.where} maps '${argument}', which '${ctx.target.id}' does not take.`,
          );
          continue;
        }
        if (typeof source !== "string") continue;
        const path = parseEffectPath(source);
        if ("error" in path) {
          flag(
            "error",
            "effect/path_invalid",
            `Operation '${op.id}' ${ctx.where}.${argument}: ${path.error}.`,
          );
          continue;
        }
        if (!ctx.roots.includes(path.root)) {
          flag(
            "error",
            "effect/path_root_not_allowed",
            `Operation '${op.id}' ${ctx.where}.${argument} reads '${path.root}', but this mapping may read only ${ctx.roots.join(", ")}.`,
          );
          continue;
        }
        checkPath(`${ctx.where}.${argument}`, source, path.root, path.segments, ctx);
      }
      const required = (targetSchema.required ?? []) as string[];
      for (const name of required) {
        if (isSafetyControl(ctx.target, name)) continue;
        const source = ctx.mapping[name];
        if (typeof source === "string" && source.endsWith("?")) {
          flag(
            "error",
            "effect/mapping_required_optional",
            `Operation '${op.id}' ${ctx.where} supplies '${name}', which '${ctx.target.id}' requires, from an optional path ('${source}').`,
          );
        }
        if (source === undefined) {
          flag(
            "error",
            "effect/mapping_missing_required",
            `Operation '${op.id}' ${ctx.where} does not supply '${name}', which '${ctx.target.id}' requires.`,
          );
        }
      }
    };

    const checkPath = (
      where: string,
      source: string,
      root: EffectPathRoot,
      segments: Array<string | number>,
      ctx: Pick<MappingContext, "request" | "response">,
    ) => {
      if (root === "idempotency_key") return;
      const schema = root === "request" ? ctx.request : ctx.response;
      const result = effectPathInSchema(schema, segments, schemas);
      if (result === "missing") {
        flag(
          "error",
          "effect/path_unresolved",
          `Operation '${op.id}' ${where}: '${source}' names nothing the ${root} schema declares.`,
        );
      } else if (result === "unverifiable") {
        flag(
          "info",
          "effect/path_unverified",
          `Operation '${op.id}' ${where}: '${source}' could not be checked against the ${root} schema; a call whose ${root} lacks it gets no follow-up.`,
        );
      }
    };

    const checkDeadline = (where: string, deadline: EffectDeadline | undefined) => {
      if (!deadline) return;
      const both = deadline.withinMs !== undefined && deadline.at !== undefined;
      const neither = deadline.withinMs === undefined && deadline.at === undefined;
      if (both || neither) {
        flag(
          "error",
          "effect/deadline_shape",
          `Operation '${op.id}' ${where}.deadline needs exactly one of within_ms or at.`,
        );
        return;
      }
      if (deadline.at !== undefined) {
        const path = parseEffectPath(deadline.at);
        if ("error" in path || path.root !== "response") {
          flag(
            "error",
            "effect/deadline_path",
            `Operation '${op.id}' ${where}.deadline.at must be a response path: '${deadline.at}'.`,
          );
          return;
        }
        checkPath(`${where}.deadline.at`, deadline.at, path.root, path.segments, {
          request: inputSchema,
          response: outputSchema,
        });
      }
    };

    for (const [where, undo] of [
      ["inverse", e.inverse],
      ["compensate", e.compensate],
    ] as const) {
      if (!undo) continue;
      const found = target(where, undo.operation, "mutation");
      if (found) {
        checkMapping({
          where,
          target: found,
          mapping: undo.arguments,
          roots: ["request", "response"],
          request: inputSchema,
          response: outputSchema,
        });
      }
      checkDeadline(where, undo.deadline);
    }

    if (e.lookup) {
      const found = target("lookup", e.lookup.operation, "read");
      const byKey = e.lookup.by === "idempotency_key";
      if (byKey && !operationForwardsIdempotencyKey(op)) {
        flag(
          "error",
          "effect/lookup_without_idempotency_key",
          `Operation '${op.id}' looks its effect up by idempotency key, but sends no key upstream; declare its idempotency carrier, or look up by id.`,
        );
      }
      if (
        byKey &&
        !Object.values(e.lookup.arguments).some((source) => source === "idempotency_key")
      ) {
        flag(
          "error",
          "effect/lookup_key_unused",
          `Operation '${op.id}' looks its effect up by idempotency key, but no lookup argument reads idempotency_key.`,
        );
      }
      if (found) {
        checkMapping({
          where: "lookup",
          target: found,
          mapping: e.lookup.arguments,
          roots: byKey
            ? ["request", "idempotency_key"]
            : ["request", "response", "idempotency_key"],
          request: inputSchema,
          response: outputSchema,
        });
      }
    }

    if (e.draft) {
      const draftOp = target("draft", e.draft.operation, "mutation");
      if (draftOp) {
        checkMapping({
          where: "draft",
          target: draftOp,
          mapping: e.draft.arguments,
          roots: ["request"],
          request: inputSchema,
          response: undefined,
        });
        const handle = parseEffectPath(e.draft.handle);
        if ("error" in handle || handle.root !== "response") {
          flag(
            "error",
            "effect/draft_handle",
            `Operation '${op.id}' draft.handle must be a response path into the draft's answer: '${e.draft.handle}'.`,
          );
        } else {
          checkPath("draft.handle", e.draft.handle, handle.root, handle.segments, {
            request: inputSchema,
            response: draftOp.output.schema,
          });
        }
      }
      for (const [where, followUp] of [
        ["draft.promote", e.draft.promote],
        ["draft.discard", e.draft.discard],
      ] as const) {
        if (!followUp) continue;
        const found = target(where, followUp.operation, "mutation");
        if (!found) continue;
        checkMapping({
          where,
          target: found,
          mapping: followUp.arguments,
          roots: ["request", "response"],
          request: inputSchema,
          response: draftOp?.output.schema,
        });
      }
    }

    if (errors.length > 0) {
      // Never serve an undo the compiler could not prove callable: keep the
      // class's conservative reading and drop every follow-up declaration.
      const safeClass = e.kind === "read" ? "read" : "irreversible";
      op.effect.class = safeClass;
      op.effect.reversible = safeClass === "read";
      delete op.effect.inverse;
      delete op.effect.compensate;
      delete op.effect.lookup;
      delete op.effect.draft;
      const note = `Effect contract rejected (${errors.length} error(s)); served as ${safeClass} with no undo until it is fixed: ${errors[0]}`;
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    }
  }
  return diagnostics;
}

/** Whether `name` is one of the operation's synthesized safety controls (not a real input). */
function isSafetyControl(op: Operation, name: string): boolean {
  const safety = operationSafetyInputKeys(op);
  if (name === safety.confirm) return op.confirmation.required;
  if (name === safety.idempotencyKey) return idempotencyModeUsesCarrier(op.idempotency.mode);
  return false;
}
