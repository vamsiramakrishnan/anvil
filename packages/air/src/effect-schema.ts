import { z } from "zod";
import { EffectClass } from "./enums.js";

/**
 * AIR's effect contract (ADR-0030), as the fields it adds to an operation's
 * `effect`. The semantics, the path grammar, and the resolution rules live in
 * `effect-contract.ts`; the compiler's checks in `@anvil/compiler`'s
 * `effects.ts`. Every field is optional, so an operation that declares none
 * serializes (and hashes) as it did before the contract existed.
 */

/**
 * Where one argument of a follow-up call (an inverse, a compensation, a lookup,
 * a draft or its promotion) comes from: a path into the original call
 * (`request.owner`, `response.id`, `response.items[0].id`, `idempotency_key`;
 * the grammar is `effect-contract.ts`'s `parseEffectPath`), or a literal
 * `{ const: value }`. Resolved by `resolveEffectArguments`; the compiler
 * checks every path against the operations' schemas.
 */
export const EffectArgumentSource = z.union([
  z.string().min(1),
  z.object({ const: z.unknown() }).strict(),
]);
export type EffectArgumentSource = z.infer<typeof EffectArgumentSource>;

/** Target input name (the follow-up tool's argument) → where its value comes from. */
export const EffectArgumentMapping = z.record(z.string().min(1), EffectArgumentSource);
export type EffectArgumentMapping = z.infer<typeof EffectArgumentMapping>;

/**
 * Until when an inverse or compensation still works. `withinMs` counts from
 * the moment the original call answered; `at` is a `response.*` path to an
 * ISO-8601 timestamp or epoch milliseconds the upstream returned. Exactly one
 * (the compiler checks).
 */
export const EffectDeadline = z
  .object({
    withinMs: z.number().int().positive().optional(),
    at: z.string().min(1).optional(),
  })
  .strict();
export type EffectDeadline = z.infer<typeof EffectDeadline>;

/** A follow-up call that undoes (`inverse`) or cancels (`compensate`) an effect. */
export const EffectUndo = z
  .object({
    /** AIR id of the operation to call. */
    operation: z.string().min(1),
    arguments: EffectArgumentMapping.default({}),
    deadline: EffectDeadline.optional(),
  })
  .strict();
export type EffectUndo = z.infer<typeof EffectUndo>;

/**
 * How to find out whether an effect happened when its answer was lost: a read
 * called with the idempotency key the call carried (`by: idempotency_key`) or
 * with an id the request or response named (`by: id`). It answers `not_found`
 * (or nothing) when the effect did not happen.
 */
export const EffectLookup = z
  .object({
    operation: z.string().min(1),
    by: z.enum(["idempotency_key", "id"]),
    arguments: EffectArgumentMapping.default({}),
  })
  .strict();
export type EffectLookup = z.infer<typeof EffectLookup>;

const EffectFollowUp = z
  .object({ operation: z.string().min(1), arguments: EffectArgumentMapping.default({}) })
  .strict();

/**
 * The operation's draft form: a staged call performs `operation` (the draft;
 * it may be this operation itself, called with a draft flag) instead, reads
 * the draft's `handle` (a `response.*` path) from its answer, and hands back
 * the `promote` call that performs the real effect and, when declared, the
 * `discard` call that throws the draft away. `arguments` read the staged
 * request; `promote.arguments` and `discard.arguments` read the staged
 * request and the draft's response.
 */
export const EffectDraft = z
  .object({
    operation: z.string().min(1),
    arguments: EffectArgumentMapping.default({}),
    handle: z.string().min(1),
    promote: EffectFollowUp,
    discard: EffectFollowUp.optional(),
  })
  .strict();
export type EffectDraft = z.infer<typeof EffectDraft>;

/** The fields `Effect` gains (spread into it in `schema.ts`). */
export const EffectContractShape = {
  /**
   * What undoing this effect means. Undeclared is `read` for a read and
   * `irreversible` for anything else (`effectClassOf`): unknown is treated
   * as the worst case.
   */
  class: EffectClass.optional(),
  /** The true inverse of a `reversible` effect. */
  inverse: EffectUndo.optional(),
  /** The call that cancels a `compensable` effect, leaving a trace. */
  compensate: EffectUndo.optional(),
  /** How a reconciler finds out whether the effect happened. */
  lookup: EffectLookup.optional(),
  /** The operation's draft form and its promotion. */
  draft: EffectDraft.optional(),
};
