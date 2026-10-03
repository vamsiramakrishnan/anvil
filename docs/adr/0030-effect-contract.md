# ADR-0030 — Operations declare how their effects are undone

**Status:** Accepted

## Context

Branchyard keeps an effect ledger: one entry per call a task makes that
changes something outside the machine, written before the call and finished
after it. Undo, approvals, and reconciliation all read that ledger. The
contract both repositories build to is Branchyard's `docs/effects.md`
("The contract with Anvil"); this ADR records Anvil's side of it.

The split of ownership is:

- **Anvil** owns what an operation means: whether its effect can be undone,
  and by which call with which arguments; how to look the effect up when its
  answer was lost; and whether it has a draft form.
- **Branchyard** owns the ledger, the approvals, and the undo plan. It decides
  when to undo; Anvil never undoes anything on its own.

AIR already carried `effect.kind` (`read` or `mutation`, the safety core),
`effect.reversible` (a descriptive boolean that defaults to `true` and drives
the destructive hint), and the idempotency carrier
(`idempotency.mode`/`mechanism`/`key`), which the executor already uses to
send a key upstream. What was missing: an effect class a ledger can act on,
the inverse and compensating calls with arguments resolved from the original
call, a lookup for reconciliation, a draft form, and a way for a caller to
hand the gateway its ledger id and get the resolved undo back.

## Decision

**1. AIR declares the contract on `effect`.** Five optional fields join
`Effect` (`packages/air/src/effect-schema.ts`):

| Field | Meaning |
| --- | --- |
| `class` | `read`, `reversible`, `compensable`, or `irreversible`. |
| `inverse` | `{operation, arguments, deadline?}`: the call that leaves the world as it was. |
| `compensate` | The same shape: the call that cancels the effect but leaves a trace. |
| `lookup` | `{operation, by: idempotency_key \| id, arguments}`: a read that finds the effect. |
| `draft` | `{operation, arguments, handle, promote, discard?}`: the draft form and the calls that publish or discard it. |

Every field is optional, so an operation that declares none serializes and
hashes as before. Undeclared, the class is `read` for a read and
`irreversible` for anything else (`effectClassOf`): a connector compiled
before this ADR reads as the worst case. The existing `reversible` boolean is
kept; a declared class sets it (`read` and `reversible` → `true`, otherwise
`false`) unless the same manifest entry sets it, and the two may not
disagree.

**2. Arguments are mappings with a small path grammar.** A mapping names
each argument of the follow-up call (the follow-up tool's input names) and
where its value comes from: `request.<path>` (the original call's arguments),
`response.<path>` (the upstream's answer), `idempotency_key` (lookups only),
or a literal `{const: value}`. A path is dotted property names and `[n]`
indices; a trailing `?` makes the argument optional. There are no wildcards,
filters, or expressions. A path that names nothing at run time makes the
follow-up unavailable (`undo: null` with `undo_unavailable` saying why), never
a call with a gap. A `deadline` is `withinMs` (from the moment the call
answered) or `at` (a `response.*` path to an ISO-8601 time or epoch
milliseconds), resolved to epoch milliseconds.

**3. The manifest writes it; the compiler checks it.** An operation's
manifest entry takes an `effect:` block (snake case: `within_ms`), carried
through the overlay mechanism as one combined, contested predicate
(`effectContract`), like `asyncContract`. Operation references take any
spelling a manifest key takes and are pinned to AIR ids. The compiler
(`packages/compiler/src/effects.ts`) then checks, with `effect/*` error
diagnostics: referenced operations exist; an inverse or compensation is a
mutation and a lookup a read; a reversible effect has an inverse and a
compensable one a compensation, and neither class appears where it does not
belong (a read with a non-read class, an irreversible effect with an
inverse); every mapped argument is an input of the target, every required
input is mapped (not from an optional path), and no mapping sets a safety
control (`confirm`, the idempotency key: those are the caller's); a mapped
value's type (a literal's, or the type the source schema declares at a path)
fits the target input's declared type (`effect/mapping_type_mismatch`; an
integer fits a number, nothing else converts, and undeclared types are not
judged); every path
parses, reads only the roots its place allows (a lookup by key cannot read
the response it exists to replace; a draft reads only the request), and
names something the request or response schema declares (`missing` when the
schema declares its properties and not this one; an opaque schema is an
`info` diagnostic, not a refusal); a lookup by key belongs to an operation
that sends a key upstream; a deadline has exactly one form. An operation whose
contract has an error is served as `irreversible` (or `read`) with every
follow-up removed and a review note, so the gateway never offers an undo the
compiler could not prove callable. Because confirmation was classified while
the contract still promised an undo, a rejected mutation's confirmation is
tightened to required (an irreversible write confirms) and its input schema
republished. An operation whose draft form needs confirmation must take a
confirm input itself, since a staged call can confirm the draft only through
it: the compiler requires confirmation on it (`effect/confirmation_for_draft`,
a warning) when a manifest waived it. A follow-up that is not approved is a
warning: callers will be refused it until it is.

**4. The gateway reports the effect of every operation call.** The MCP
serving path (`@anvil/mcp-runtime`'s `effects.ts`, wired in `server.ts`)
attaches `_meta.effect` to every operation result except a dry run:

```json
{
  "class": "reversible",
  "operation": "github.comments.create",
  "idempotency_key": "01JBRANCHYARDLEDGER00000001",
  "undo": {
    "kind": "inverse",
    "operation": "github.comments.delete",
    "tool": "github__github_delete_comment",
    "arguments": { "owner": "octo", "repo": "hello", "comment_id": 100 }
  },
  "deadline_ms": null,
  "lookup": null
}
```

`undo.kind` is `inverse` for a reversible effect and `compensate` for a
compensable one; a reversible effect that also declares a compensation
carries it as `compensate` (for after the deadline). `tool` is the name a
caller dials on this gateway: a fleet rewrites the bundle's own names to its
prefixed ones. A failed call carries the class, the key, and the lookup, and
no undo. `tools/list` publishes the declaration itself (`anvil/effect_class`,
`anvil/effect_contract`) for operations that declare one, so a reconciler can
resolve a lookup when an answer never arrived; operations that declare none
list exactly as before.

**5. The caller's key is the ledger id, forwarded where a carrier exists.** A
`tools/call` may carry `_meta.idempotency_key`. When the operation declares an
idempotency carrier, the key goes into the operation's own idempotency input
and the executor sends it upstream exactly as it sends any key (header,
query, body, or path); a different key already in the arguments is a
`validation_error`. When the operation has no carrier the key is not sent:
inventing a header the upstream ignores would claim protection that does not
exist. `idempotency_key` in the report is the key that actually went
upstream, or `null`. The audit line gains `effect_class`, `ledger_id` (the
caller's key, whether or not it was forwarded), and `staged_for`. A fleet
forwards only `idempotency_key` and `stage` from a caller's `_meta` to the
bundle; a progress token belongs to its own hop.

**6. Undo is an ordinary call.** There is no undo endpoint. A caller calls
`undo.tool` with `undo.arguments` (adding its own `confirm` where the
follow-up needs one) under the same token, and the same grant, gates, and
audit apply. A grant that does not allow the inverse refuses it like any
other call.

**7. Staging performs the draft form.** `_meta.stage: true` on an operation
with a `draft` performs the draft operation instead (it may be the operation
itself with a draft flag, such as a release created with `draft: true`),
under that operation's own gates; the caller's `confirm` carries to it, and
the mapped input is validated against the draft tool's own input schema
before anything runs (`effect/draft_input_invalid`). The
answer is the draft's response, and `_meta.effect` describes the staged
effect (its class, no undo) plus `staged: {draft_operation, handle, promote,
discard}`. Calling `promote` performs the real effect; `discard` throws the
draft away. Staging an operation without a draft form is refused
(`unsupported_operation`, `effect/no_draft_form`) and never falls through to
the real effect. `effect/draft_unavailable` and
`effect/draft_argument_missing` refuse a draft the server does not serve or
cannot fill; `effect/invalid_meta` refuses a malformed `_meta`.

**8. A REST route for callers that do not speak MCP.** The fleet listener
serves `POST /call/<tool>` with the same authorization as `/mcp`. The body
is `{"arguments": {...}, "stage": true?}`; the `Idempotency-Key` header is
the key. The call runs through a fleet composed for that caller over an
in-process MCP pair, so it reaches the same `execute()`, grant, and audit as
`/mcp`. The answer is the response data (`200`), or `{"error": envelope}`
with a status for its code (`400` validation, `401` auth, `403`
policy or permission, `404` not found, `409` conflict, `422` unsupported,
`428` confirmation or idempotency required, `429` rate limited, `502`/`504`
upstream); the report rides in `X-Anvil-Effect` as JSON with non-ASCII
escaped. A tool the gateway does not mount is `404`.

**9. Surfaces say what an action means.** A bundle's `reference/operations.md`
adds an `Undo:` line for operations that declare a contract. A harness
package's `SKILL.md` labels each operation `read`, `write, can be undone`,
`write, can be compensated (not undone)`, or `write, cannot be undone`, and
`harness.json` lists each operation's `effect_class` and declared `undo`.

**10. The fixture shows each class.** `examples/github-mini` gains comments,
issue updates, and releases: `comments.create` is reversible (the inverse
deletes it; the mock honours `Idempotency-Key`, which GitHub itself does
not); `issues.create` is compensable (closing it); `releases.create` is
irreversible with a draft form (`draft: true`, promoted by `releases.update`,
discarded by `releases.delete`, looked up by tag). `e2e.mjs` drives all of it
over MCP and REST.

## Consequences

- Branchyard can write a ledger entry with its id as the key, finish it from
  `_meta.effect`, plan undo from `undo`, reconcile `unknown` through `lookup`,
  and stage irreversible operations that have a draft form. Every operation
  without a declaration reports `irreversible` (or `read`) with no undo.
- Results from every serving path that uses `buildMcpServer` (single-bundle
  and deployed servers too) now carry `_meta.effect`; clients that ignore
  `_meta` see no change. `tools/list` and disclosure measurements change only
  for operations that declare a contract.
- **Not done:**
  - Anvil does not verify that a declared inverse is a true inverse; the
    declaration is a reviewed claim, like idempotency.
  - The generated CLI and SDKs do not yet send `_meta.idempotency_key` or
    `_meta.stage`, or surface `_meta.effect`; they pass keys as the
    operation's idempotency input, as before. Branchyard calls the gateway
    directly.
  - A lookup's answer is not interpreted: Branchyard treats a successful
    lookup as found and `not_found` (or an empty list) as not.
  - The REST route composes a fleet per request (no session reuse) and takes
    a body of at most 64 KiB.
  - A staged call reports no undo for the draft itself; `discard` is how a
    draft is thrown away.
