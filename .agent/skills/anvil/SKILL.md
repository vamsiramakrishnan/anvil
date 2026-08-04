---
name: anvil
description: Use this skill to operate Anvil — compile API specifications (OpenAPI 3.x, Swagger 2.0, Google Discovery, GraphQL SDL, gRPC/proto3 (multi-file), SOAP/WSDL (multi-file), OData v2/v4 ($metadata/EDMX), Postman Collections) into agent-ready CLI + MCP + skill bundles, enrich unsafe-operation semantics, approve operations, and deploy. Use when turning an API specification into safe agent tools.
---

# Operating Anvil

Anvil is an agent toolchain compiler. It turns a spec into three aligned
surfaces (CLI, MCP server, skill) from one model (AIR). Your job as a harness is
to drive Anvil safely, not to invent semantics.

## What Anvil can compile
- OpenAPI 3.x
- Swagger 2.0
- Google Discovery
- GraphQL SDL
- gRPC/proto3 (multi-file)
- SOAP/WSDL (multi-file)
- OData v2/v4 ($metadata/EDMX)
- Postman Collections

Every source format lands in the same canonical model (AIR) and the same
aligned MCP server + CLI + skill bundle.

## If the source is a gateway estate
Do not start with `compile`. Read `reference/gateway-estates.md`; run
`anvil estate inventory`, `anvil estate audit`, and `anvil estate plan`;
initialize triage with `--init-selection`; then review the exact coordinate,
contract, gateway identity, semantic lane, and strict per-API import.
For overlap across verified bundles, read
`reference/composing-capabilities.md` and use audit-only
`anvil capability compose`. It produces no AIR, MCP, approval, or build input.

## The loop
1. `anvil compile <spec> --manifest <manifest> --out <dir>` — build the bundle.
2. `anvil status <dir>` — orient on projections, gates, evidence, target, and release state; follow its next safe action.
3. `anvil inspect <dir>` and `anvil lint <dir>` — inspect risk and fix diagnostics. Non-idempotent mutations remain `review_required`.
4. Enrich unsafe or weakly named operations via a manifest; `anvil distill <dir> --as-enrich-plan` targets residue for `anvil enrich --plan` (see reference/workflow.md).
5. `anvil approve <dir> <operation-id...>` — expose operations only after inspecting risk. Receipt-bound gateway bundles instead require reviewed state in the supplemental manifest and a re-import, preserving immutable import-to-approval lineage.
6. For Gemini Enterprise, generate the target now: `anvil target gemini-enterprise <dir> --surface <custom-mcp|agent-gateway> --server-auth <oauth|no-auth> ...`. Keep its deployment inputs outside compiler-owned output.
7. Run `anvil deploy ledger <dir> --project <project-id> --database <firestore-database>` to inspect writes and verify the store contract. Shared mode is the default; dedicated also needs immutable location. Its tfvars bind non-secret plan identity; live readiness remains unverified.
8. Run `anvil status <dir>`, then certify the complete bundle. Target and idempotency-store artifacts are deployment inputs and part of the certified hash.
9. Run `anvil selftest <dir>`, `anvil conformance <dir>`, and `anvil simulate <dir>`; each report must pass against that same bundle hash.
10. Prepare a plan with `anvil publish <dir>` only after static assurance and all three executable lanes are fresh and passing. A non-prod-only `--allow-incomplete-evidence` waiver is explicit in the plan; prod fails closed.
11. After the endpoint is live, require `/readyz` HTTP 200 for ledger-backed writes, then complete the external Gemini console or guarded Agent Gateway registration steps. See reference/gemini-enterprise.md.

## Safety rules
- **Never approve an operation you have not inspected.** Only approved operations are exposed.
- **Do not** hand-wave idempotency. If a POST is not provably idempotent, either supply a manifest idempotency policy or leave it `review_required`.
- Prefer `anvil run <dir> ... --dry-run` before any real invocation.
- Treat `review_required` as a stop sign, not a nuisance.

## Where to look
- `reference/commands.md` — every command and what it does.
- `reference/workflow.md` — the enrich → approve workflow and manifest shape.
- `reference/gateway-estates.md` — whole-estate audit, native-format boundaries, view/BFF semantics, and receipt-safe adoption.
- `reference/composing-capabilities.md` — audit and review cross-bundle read overlap without inferring authority or generating MCP.
- `reference/gemini-enterprise.md` — choose and safely configure one Gemini Enterprise BYO-MCP journey.
- `reference/upstream-credentials.md` — configure outbound authentication from the runtime to the upstream API.
- `reference/durable-idempotency.md` — configure the managed write ledger and distinguish static wiring, live readiness, and bounded guarantees.
- `evals/operate_anvil.yaml` — behavior checks for operating Anvil.

Run `anvil --help` before guessing.
