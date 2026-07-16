---
name: anvil-enrich
description: Triangulate a better, behaviorally-grounded spec by enriching AIR from the systems' own published MCP servers (Confluence docs, GitHub/GitLab code, Postman traffic). Two parts — an interactive interview to define which sources to consult (`anvil sources init`), then evidence-graded enrichment (`anvil enrich`) that proposes a manifest patch. Use when a compiled spec is thin: missing idempotency/confirmation, weak descriptions, undocumented errors, or view-shaped names that need real behavioral meaning.
---

# Enriching a spec from its own systems of record

A raw spec is incomplete — no idempotency, no confirmation posture, thin
descriptions, view-shaped names. The behavioral truth lives in the systems the
API is *documented and implemented in*: Confluence pages, the service's repo,
saved Postman traffic. Anvil is an MCP **client**: it connects to the servers
those systems already publish, gathers evidence per operation, and proposes a
manifest patch — **propose-only, nothing touches AIR** until you compile it.

The evidence is **tier-weighted**, and that asymmetry is the whole safety story:

- **Code hosts** (github / gitlab / a vendor's own server: salesforce, sap) →
  `source_impl`. The only tier that can **loosen** safety — a literal
  `Idempotency-Key` in the repo can enable retries.
- **Docs** (confluence / notion / jira) → `doc_example`. Can **tighten** and
  corroborate (undocumented errors, deprecations, rate limits, and the intent
  phrases agents route on) but **never loosens safety alone**.
- **Postman** → real-usage; corroborates, stays below the loosen bar.

## Part 1 — the interview: define the sources (`anvil sources init`)

Defining which servers to enrich from is a judgement call you make *with the
operator*, not something to hard-code. Scaffold it, then interview:

```
anvil sources init <dir> --json        # proposal + the questions to ask
```

`init` reads the compiled AIR and proposes the two evidence poles (a code host,
a docs host), any product vendor it detects (Salesforce/SAP), and a Postman
source when the spec came from a collection. It returns `questions` — put each to
the operator:

1. **Code host + repo** — which repo implements this? (github|gitlab, `repo:org/name`)
   This is the only source that can loosen safety, so it's worth getting right.
2. **Docs host + space** — which space/space-key documents behavior? (confluence|notion, `space:KEY`)
3. **Vendor / Postman** — confirm the detected org/workspace, if any.
4. **Secrets** — the `requiredEnv` vars (e.g. `CONFLUENCE_URL`, `GITHUB_TOKEN`)
   must be in the environment; never write them into the file.

Fill the `<…>` scopes with the operator's answers and save
`sources.yaml` (`anvil sources init <dir> --write sources.yaml`, then edit).

## Part 2 — enrich (`anvil enrich`)

```
anvil enrich <dir> --sources sources.yaml --write anvil.manifest.yaml --json
```

Anvil connects to each server, gathers evidence per operation, and proposes
idempotency / confirmation / descriptions / error taxonomy. Read the per-operation
decisions:
- A **loosen** (e.g. `retryable: true`, or an idempotency strategy that enables
  retries) must cite `source_impl` / traffic evidence. If it cites only docs,
  it's refused — that's correct.
- **Tightening** (a new error, a deprecation, a description, an intent phrase)
  from docs is welcome; it makes the surface honest and improves routing.
- Outcomes `insufficient_evidence`, `conflicted`, `blocked_by_missing_source`
  are answers, not failures — add the missing source or leave the op as-is.

Then reproject: `anvil compile <spec> --manifest anvil.manifest.yaml --out <dir>`.

## How this closes the loop with distillation

`anvil distill` (the eigenbasis pass) tells you *where* enrichment is worth the
round-trip, and hands it over as a plan:

```
anvil distill <dir> --as-enrich-plan --write plan.json   # the surface's open questions
anvil enrich <dir> --sources sources.yaml --plan plan.json --write anvil.manifest.yaml
```

The plan turns distillation's open questions into **source-routed probes**, one per
UNCERTAIN operation (clean-basis ops are skipped entirely):
- **unproven-idempotency writes** (highest priority) → ask a **code** source to
  prove an idempotency key (the only thing that can loosen safety).
- **review clusters** (same-signature mutations) → a code idempotency question +
  a docs "deprecated/superseded?" question.
- **stranded intents** ("show the mobile summary view") → a **docs** question:
  meaningful projection, or flab? (a keep/re-home usability call — no safety change).
- **weak/vague names** (`doTransition`) → an any-source "what does it do?" question.

The plan is **advisory routing only** — it never sets a manifest field or changes a
threshold; `reconcile` still owns the tier (docs tighten / code loosens). So: distill
finds what's uncertain → the plan aims the sources at those ops → enrich resolves it →
re-distill with the grounded intent phrases. The conversion gets better each pass.

## Rules

- **Docs never loosen safety.** Only implementation/traffic evidence clears the
  loosen bar; a validator enforces it — don't try to override it.
- **Secrets stay in the environment.** `sources.yaml` names `${VAR}`s, never values.
- **Propose, then compile.** Enrichment writes a manifest; AIR only changes when
  you run `compile --manifest`, so every enrichment is reviewable and reversible.
