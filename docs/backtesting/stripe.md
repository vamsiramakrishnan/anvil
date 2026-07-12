# Stripe API backtest

- **Spec**: the real stripe spec (fetched by `reproduce.sh stripe`) — 22 operations trimmed verbatim
  from `stripe/openapi`'s `spec3.json` (414 real paths total; the curated
  subset covers customers, charges, payment intents, refunds, invoices,
  subscriptions), chosen to overlap Stripe's official agent toolkit.
- **Reference**: `stripe/agent-toolkit` (official, hosted at
  `mcp.stripe.com`) — Stripe's own curated tool set covers this exact
  surface (customers, payments, refunds, invoices, subscriptions, search).
- **Manifest**: `docs/backtesting/reproduce/manifests/stripe.anvil.yaml` — every mutation declares
  Stripe's real, documented `Idempotency-Key` header convention (not
  expressible in the OpenAPI spec itself — see below), grounded in
  https://docs.stripe.com/api/idempotent_requests.

## Compile → inspect → lint → package, run for real

```
$ anvil compile --source <id> --manifest docs/backtesting/reproduce/manifests/stripe.anvil.yaml --service stripe --out generated/stripe
Compiled 22 operations ... approved: 22  review_required: 0
$ anvil lint generated/stripe          # exit 0 — depth-truncation info + naming findings, no errors
```

This is the product that actually broke the compiler — six separate real
bugs, all fixed with tests (see `deficiencies.md` #6–#12). Stripe's ~860
schemas are extensively mutually cross-referential in a way none of
Jira/Confluence/GitHub's curated subsets were, and that structural
difference is exactly what surfaced problems the other three products
couldn't have found.

**The headline result isn't the bug count, it's the redesign.** The first
fix (#6–#9) was a depth-bounded patch on top of full `$ref` inlining — it
worked, but it truncated real structure that didn't need to be thrown away.
Asked directly *why truncate at all, when Stripe's own spec has no such
problem*, the honest answer was: the blowup was self-inflicted by inlining
in the first place. `decycle.ts` now **bundles** the schema graph instead —
every named schema (`components.schemas.<Name>`) is processed exactly once
and referenced by `$ref` everywhere else, the same representation the real
Stripe spec and every real OpenAPI SDK generator already use — and a bounded
per-operation `materializeSchema` pass re-inlines just what one operation
needs back into a small, self-contained schema, so nothing downstream had to
change. Getting there surfaced two more real bugs (`dereference()` doesn't
share object references across repeated `$ref`s, so identity-based matching
silently did nothing; and the first re-inline pass reintroduced the same
blowup one level down, 50MB for a single operation, before the actual
per-hop cost was measured and bounded). All in `deficiencies.md` #10–#12.

## What's different about Stripe vs. the Atlassian products

- **A real, universal idempotency mechanism.** Every mutation here declares
  `strategy: required_request_key` against Stripe's actual `Idempotency-Key`
  header — the same pattern `examples/payments/anvil.yaml` (this repo's
  original hand-written example) already modeled, now demonstrated against
  the real API it was drawn from. Unlike Jira/Confluence, Stripe *can* make
  every mutation here provably retry-safe.
- **Idempotency doesn't remove confirmation.** `capturePaymentIntent`,
  `createRefund`, etc. are idempotency-key-safe *and* still confirmation-
  required, because they're financial/irreversible — retry-safety and
  "should a human approve this at all" are independent questions (see the
  `classifyConfirmation` OR-condition: risk/reversibility triggers
  confirmation regardless of idempotency; idempotency being unproven is a
  *separate* trigger).
- **Auto-generated operationIds, correctly flagged.** Every operation here
  scores `weak_operation_name` — Stripe's operationIds are literally
  `Method + Path` concatenations with no more semantic content than the
  fallback naming heuristic would produce. This is the same fix that came
  from Jira's `doTransition`, validated unprompted on a structurally
  unrelated vendor's spec.

Full bug list (compiler hang → fixed with memoization; JSON output still too
large → fixed with a depth bound; the depth bound's real root cause →
Stripe's own `x-expansionResources` marker; a downstream regression the fix
introduced → array-typed truncation) is in `deficiencies.md`.
