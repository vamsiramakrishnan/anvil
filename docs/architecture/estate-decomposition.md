# Decomposing `commands/estate/estate.ts`

**Status:** plan. No code in this document has been written yet.

`packages/cli/src/commands/estate/estate.ts` is 3,327 lines — the largest
production module in the workspace and its densest concentration of change. This
is the plan for taking it apart, written before the work so the boundaries can be
argued with rather than discovered in a diff.

## The one fact that shapes the whole plan

**The target shape already exists in this directory.** Two of estate's siblings
are already what the rest should become:

| Module | Lines | Takes `CliIO`? | Returns |
| --- | --- | --- | --- |
| `estate-audit.ts` | 724 | no | `EstateAuditReport` |
| `estate-adoption.ts` | 1,264 | no | `EstateAdoptionPlan`, plus `renderEstateAdoptionPlan(): string[]` |
| `estate.ts` | 3,327 | yes, 99 call sites | exit codes |

So this is not a design exercise. It is finishing a migration that was started,
proven, and then not completed. That materially lowers the risk: the pattern has
already survived contact with this subsystem, and the two migrated modules are
the reference implementation.

## What is actually wrong

Not the line count. The line count is a symptom of four distinct ownerships
living in one file:

1. **Delivery** — Commander wiring (`registerEstate`, lines 129–395), 99
   `io.out`/`io.err` calls, 29 `JSON.stringify` envelope constructions, and 34
   exit-code returns.
2. **Domain policy** — rules that have nothing to do with being a CLI. For
   example, inside `runImport`: `--attest-spec-override` is defined only for the
   WSO2 vendor; a supplied `--spec` requires an explicit `--gateway-url` because
   a contract's own `servers` entry is not proof that calls still traverse the
   imported gateway; an override reason must be non-empty and at most 2,000
   characters.
3. **Effects** — 32 filesystem calls: reading estate exports, writing selection
   documents, staging and installing bundles, storing receipts.
4. **Acquisition** — loading and normalising a vendor estate export.

`runImport` alone spans lines 2,249–3,162 (~913 lines) and holds 46 of the 99
`io` calls. Each of its validation branches repeats the same shape: build an
error, choose JSON or text, emit, return 1. That repetition is the tell — the
function is hand-rolling a result type that does not exist.

The cost is not aesthetic. Because the policy is expressed as "emit and return
1", it can only be tested through the CLI, and it cannot be reused by the MCP
surface, by `anvil status`, or by anything else that needs to know whether an
import is admissible.

## Target module boundaries

Seven responsibilities, in dependency order. Every one of them is a pure function
over explicit data except where marked.

| Module | Owns | Signature shape |
| --- | --- | --- |
| `estate-inventory.ts` | Acquisition: read a vendor export (dir/ZIP/native collection) into a normalised estate. **Effectful** — the only module that touches the export. | `(source, vendor) => LoadedEstate \| EstateLoadFailure` |
| `estate-model.ts` | Normalisation: estate → coordinates, route multisets, identity dimensions. Already partly present as free functions in `estate.ts`. | pure |
| `estate-audit.ts` | **Exists.** Audit and diagnostics. | pure |
| `estate-selection.ts` | Selection and planning: selection documents, templates, plan construction. Partly present in `estate-adoption.ts`. | pure |
| `estate-adoption.ts` | **Exists.** Adoption plans and receipts. | pure |
| `estate-service.ts` | Orchestration: sequences acquisition → audit → plan → install, returning a structured outcome. The only module that composes effects. | `(request, deps) => Promise<EstateImportOutcome>` |
| `estate-render.ts` | Projection: outcome → human lines or JSON envelope. | `(outcome, { json }) => { lines: string[]; code: number }` |

`estate.ts` keeps only what a Commander file should: option declarations,
argument decoding into a request object, one call into the service, one call into
the renderer.

## The seam: a request/outcome pair, not a boolean

The migration hinges on replacing "emit and return 1" with a value. Two
discriminated unions carry it:

```ts
type EstateImportRequest =
  | { ok: true; vendor: Vendor; export: SourcePath; gatewayUrl?: Url; /* … */ }
  | { ok: false; rejections: EstateRejection[] };

type EstateImportOutcome =
  | { kind: "rejected"; rejections: EstateRejection[] }
  | { kind: "imported"; receipt: GatewayImportReceipt; bundle: BundlePath; diagnostics: GatewayDiagnostic[] }
  | { kind: "verified"; /* … */ };

interface EstateRejection {
  code: string;          // the existing machine-readable code, unchanged
  message: string;
  coordinate?: GatewayCoordinate;
}
```

`code` matters: the existing codes (`gateway/spec_override_without_spec`,
`gateway_selection/invalid_gateway_id`, `gateway/unsupported_native_artifact`, …)
are part of the machine-readable contract and must survive the move byte for
byte. They move from string literals at `io.err` call sites to fields on a
rejection, which is the same value in a place that can be tested.

Discriminated unions rather than booleans, because "rejected" and "imported with
diagnostics" are genuinely different outcomes and a `success: boolean` would lose
that.

## Order of work

Behaviour-preserving throughout. One commit per step; the estate corpus
differential (`node tools/corpus/run.mjs estates`) gates every one.

0. **✅ Done — lift the transactional bundle install.** Not the first step this
   plan originally listed, and the reason for the change is worth recording.

   Mapping every error code `estate.ts` can emit against every assertion in the
   workspace found 40 of 57 covered and **17 not** — and thirteen of the
   seventeen were in this one subsystem, the one that deletes and replaces
   directories. They were uncovered *because* they were unreachable: private
   functions inside a 3,327-line module, reachable only by driving the whole CLI
   with a fixture elaborate enough to hit one branch. Coverage was a function of
   module size rather than of risk.

   That inverts the "characterise first" rule for this subsystem: extraction is
   what makes characterisation possible, so it has to come first. The move was
   mechanical (the code already had no `CliIO` and already returned a
   discriminated result), and the existing 115 estate tests plus the corpus
   differential guarded it. `estate-bundle-install.test.ts` followed
   immediately, and four mutants — removing the unmanaged-output refusal, the
   identity-collision check, the rollback, and the backup-cleanup warning — each
   turn it red.

   Result: estate.ts 3,327 → 2,775.

1. **Characterise the rest.** Extend `estate.bugbash.test.ts` so the error codes
   still reachable only through `runImport`, `runPlan`, `runAudit`,
   `runInventory`, and `runVerify` are asserted from the outside — both text and
   `--json`. Four codes remain unasserted, all in `runImport`'s
   contract-attestation branch: `formal_definition_source_missing`,
   `route_set_ambiguous`, `runtime_coordinate_attested`,
   `unnecessary_spec_override`.
2. **Extract the renderer.** Move envelope construction and text formatting into
   `estate-render.ts`, still called from the same places. Pure move; the 29
   `JSON.stringify` sites collapse into a handful of projections.
3. **Introduce the request decode.** `decodeImportRequest(opts)` returns the
   union above. `runImport` calls it and immediately renders rejections. No
   policy changes; the branches simply return values instead of emitting.
4. **Lift acquisition.** `estate-inventory.ts` takes over export loading, with
   `loadEstateConfig`/`loadEstateForCommand` moving wholesale.
5. **Lift the service.** `estate-service.ts` takes the orchestration body of
   `runImport`; `runImport` becomes decode → service → render.
6. **Repeat for the smaller verbs** — `runPlan`, `runAudit`, `runInventory`,
   `runVerify` — reusing the same seam. `runVerify` carries a known duplication:
   it re-implements bundle-vs-receipt verification inline, with different error
   handling and a different code set from `verifyBundleDirectory`. Deduplicating
   is a semantic change and belongs in this step, not in a mechanical move.
7. **Delete.** The old helpers, the per-branch emitters (`emitPlanError`,
   `emitEstateImportError`), and the duplicated JSON envelopes go. If both the
   old and new paths remain, the migration is not done.

## What gets deleted

`emitEstateImportError`, `emitPlanError`, `printDiagnostics`, the 29 inline
envelope constructions, and the per-branch `io.err(...); return 1;` pairs. The
module-size baseline entry for `estate.ts` drops at each step; the ratchet in
`packages/cli/src/boundaries.test.ts` requires the recorded number to come down
with it, so the improvement is banked rather than left as headroom.

## Invariants this must not disturb

- **Machine-readable codes are a contract.** Every existing error code and JSON
  envelope shape survives unchanged. The characterisation tests in step 1 are
  what prove it.
- **Receipt-bound lineage.** Import → receipt → approval lineage is immutable
  (ADR-0016, ADR-0027). Nothing in this plan touches receipt content or ordering.
- **No Commander objects below the delivery boundary.** `Command` and `CliIO`
  stop at `estate.ts`. A domain function that needs to report something returns
  it.
- **Adoption stays evidence-bound.** Moving plan construction must not let an
  adoption decision be reached from anything other than the evidence that reaches
  it today.

## Explicitly not in scope

Changing what an estate import *means*. This plan moves ownership; any semantic
change to gateway identity, receipts, or adoption is a separate change with its
own evidence.
