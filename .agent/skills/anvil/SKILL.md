---
name: anvil
description: Use this skill to operate Anvil — compile supported API specifications into aligned CLI, MCP, skill, and SDK bundles; inventory offline legacy estates; refine, approve, and deploy. Use when turning API contracts or legacy exports into safe agent tools or clients.
---

# Operating Anvil

Anvil is an agent toolchain compiler: one model (AIR) projected into four
aligned surfaces — CLI, MCP server, skill, and TS/Python/Go/Java SDKs. Your job
as a harness is to drive it safely, not to invent semantics.

## What Anvil can compile
OpenAPI 3.x · Swagger 2.0 · Google Discovery · GraphQL SDL · gRPC/proto3 (multi-file) · SOAP/WSDL (multi-file) · OData v2/v4 ($metadata/EDMX) · Postman Collections · Captured traffic (HAR 1.2, review-only)

All of them land in the same AIR model and the same aligned bundle.

## If the source is a gateway estate
Do not start with `compile` — a route table is not a contract. Run
`anvil estate inventory`, `anvil estate audit`, and `anvil estate plan`;
triage with `--init-selection`; adopt one API at a time against its exact
coordinate, contract, gateway identity, and semantic lane
(reference/gateway-estates.md). For overlap across verified bundles use
audit-only `anvil capability compose` — no AIR, MCP, approval, or build input.

## If no API description exists
Run `anvil legacy inventory` on an offline export, then refine one exact
candidate. Inventory finds technical facts; refinement separates harness
proposals from human approval. Neither touches the runtime.

## The loop
1. `anvil compile <spec> --manifest <manifest> --out <dir>` — build the bundle.
2. `anvil status <dir>` — orient on projections, gates, evidence, and release state; follow its next safe action.
3. `anvil inspect <dir>` and `anvil lint <dir>` — inspect risk and fix diagnostics. Non-idempotent mutations remain `review_required`.
4. Enrich unsafe or weakly named operations via a manifest; `anvil distill <dir> --as-enrich-plan` targets residue for `anvil enrich --plan` (reference/workflow.md).
5. `anvil approve <dir> <operation-id...>` — expose operations only after inspecting risk. Receipt-bound gateway bundles approve differently (supplemental manifest + re-import, preserving import-to-approval lineage); see reference/gateway-estates.md.
6. `anvil sdk <dir>` — review the four client SDKs under `sdk/`: one method per approved operation, same gates. Then measure what you exposed: `anvil disclosure` prices the surface, `anvil benchmark` routes it (reference/measuring-the-surface.md).
7. For Gemini Enterprise, generate the target now: `anvil target gemini-enterprise <dir> --surface <custom-mcp|agent-gateway> --server-auth <oauth|no-auth> ...`. Keep its deployment inputs outside compiler-owned output.
8. Run `anvil deploy ledger <dir> --project <project-id> --database <firestore-database>` to inspect writes and verify the store contract. Shared mode is the default; dedicated also needs immutable location. Its tfvars bind non-secret plan identity; live readiness remains unverified.
9. Run `anvil status <dir>`, then certify the complete bundle. Target and idempotency-store artifacts are deployment inputs and part of the certified hash.
10. Run `anvil selftest <dir>`, `anvil conformance <dir>`, and `anvil simulate <dir>`; each report must pass against that same bundle hash.
11. Prepare a plan with `anvil publish <dir>` only after static assurance and all three executable lanes are fresh and passing. A non-prod-only `--allow-incomplete-evidence` waiver is explicit in the plan; prod fails closed.
12. After the endpoint is live, require `/readyz` HTTP 200 for ledger-backed writes, then complete the external Gemini console or guarded Agent Gateway registration steps. See reference/gemini-enterprise.md.

## Safety rules
The loop above is a starting path, not a boundary; these are the boundary.
- **Never approve an operation you have not inspected.** Only approved operations are exposed.
- **Approval controls exposure, not safety posture.** `anvil approve` on an irreversible mutation whose idempotency is `none` does not make the call safe — it makes an unsafe call reachable. A deadline is not evidence.
- **Do not** hand-wave idempotency. If a POST is not provably idempotent, either supply a manifest idempotency policy or leave it `review_required`.
- Prefer `anvil run <dir> ... --dry-run` before any real invocation.
- Treat `review_required` as a stop sign, not a nuisance.

## Where to look
- `reference/commands.md` — every command and what it does.
- `reference/workflow.md` — the enrich → approve workflow and manifest shape.
- `reference/measuring-the-surface.md` — price and route the surface; too big vs too alike.
- `reference/gateway-estates.md` — whole-estate audit and receipt-safe adoption.
- `reference/legacy-estates.md` — offline evidence, conflicts, pre-bridge boundary.
- `reference/composing-capabilities.md` — cross-bundle overlap, authority not inferred.
- `reference/gemini-enterprise.md` — one Gemini Enterprise BYO-MCP journey, safely.
- `reference/upstream-credentials.md` — runtime → upstream outbound auth.
- `reference/durable-idempotency.md` — the write ledger; wiring vs readiness.
- `evals/operate_anvil.yaml` — behavior checks for operating Anvil.

Run `anvil --help` before guessing.
