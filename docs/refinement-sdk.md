# Drive refinement from a coding harness

The refinement SDK lets Codex, Claude Code, or another coding harness improve an
API contract using facts it can verify in the repository. The harness investigates;
Anvil decides whether the result is grounded, safe, measurably useful, and eligible
to reach the canonical model.

Use it when the API is technically callable but still makes an agent guess—for
example, `val` means `refund_amount_minor_units`, an error code has no recovery
action, a cursor is nested at `response_metadata.next_cursor`, or a dashboard
response mixes durable records with button and layout state.

## What the SDK changes

- Agent-facing input names can differ from exact wire names. Requests still send
  the original upstream key.
- Pagination records exact request parameters, dotted item/continuation paths,
  and documented default or maximum page sizes.
- Errors can expose reviewed domain codes, field paths, and recovery actions
  without copying raw upstream messages into the agent surface.
- Default response projections can include, exclude, or rename existing fields.
  They cannot execute expressions or synthesize values.
- Review-tier changes use receipts bound to the source contract, complete pack,
  and exact proposal. Applying a reviewed pack never reruns investigation.

## Embed the loop

```ts
import {
  applyReviewed,
  createReviewReceipt,
  runRefinements,
  type SkillExecutor,
} from "@anvil/refinement";

const executor: SkillExecutor = codingHarnessExecutor;
const pack = await runRefinements(air, { executor });

// Present pack.refinements and pack.plan to the API owner first.
const candidate = pack.refinements.find(
  (refinement) => refinement.approval.tier === "review",
);
if (!candidate) throw new Error("No review-tier proposal was produced");

const receipt = createReviewReceipt(
  pack,
  candidate.id,
  "approved",
  "api-owner@example.com",
  "Verified against the handler and contract tests.",
);

const result = applyReviewed(air, pack, [receipt]);
// Persist result.air, inspect result.changes, then regenerate the bundle.
```

The executor never receives a mutable AIR document. It receives a typed skill
contract and read-only context, then returns claims plus a target-relative patch.
Unknown fields, unsupported mutations, no-op patches, name collisions, stale
contracts, altered packs, and altered proposals fail closed.

## Use the same transaction from the CLI

```bash
anvil refine run generated/payments --out .anvil/refinement/payments
anvil refine review .anvil/refinement/payments

anvil refine approve .anvil/refinement/payments \
  'rename-field:field:payments.refunds.create:input.body.val' \
  --reviewer api-owner@example.com \
  --reason 'Confirmed in the handler and refund contract tests.'

anvil refine apply-pack generated/payments .anvil/refinement/payments --dry-run
anvil refine apply-pack generated/payments .anvil/refinement/payments
```

`apply-pack` loads receipts from `<pack-dir>/receipts/*.json` by default. Pass
`--receipt <file>` repeatedly when receipts are stored elsewhere.

## Keep the trust boundary clear

The SDK does not make a coding harness authoritative. Repository access makes the
harness better at gathering evidence, not better at approving its own conclusions.
Changes to idempotency, auth authority, query exposure, UI projections, and
agent-facing names remain human decisions unless a specific auto-approval rule
explicitly clears them.

A receipt provides integrity and stale-pack protection; it is not a digital
signature and does not authenticate the text in `reviewer`. Keep receipt files in
an access-controlled review workflow (for example, signed commits plus protected
pull-request approval) when reviewer identity is security-sensitive.
