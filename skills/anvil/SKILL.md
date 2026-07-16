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

## The loop
1. `anvil compile <spec> --manifest <manifest> --out <dir>` — build the bundle.
2. `anvil inspect <dir>` — read every operation's effect, risk, and idempotency.
3. `anvil lint <dir>` — fix diagnostics. Non-idempotent mutations are `review_required`.
4. Enrich: write an Anvil manifest to declare idempotency, confirmation, retry policy, and routing names for unsafe or weakly-named operations. `anvil distill <dir> --as-enrich-plan` targets the residue for `anvil enrich --plan` (see reference/workflow.md).
5. `anvil approve <dir> <operation-id...>` — expose operations only after inspecting risk.
6. `anvil package skill <dir>` and `anvil deploy cloud-run <dir> --env prod`.

## Safety rules
- **Never approve an operation you have not inspected.** Only approved operations are exposed.
- **Do not** hand-wave idempotency. If a POST is not provably idempotent, either supply a manifest idempotency policy or leave it `review_required`.
- Prefer `anvil run <dir> ... --dry-run` before any real invocation.
- Treat `review_required` as a stop sign, not a nuisance.

## Where to look
- `reference/commands.md` — every command and what it does.
- `reference/workflow.md` — the enrich → approve workflow and manifest shape.
- `evals/operate_anvil.yaml` — behavior checks for operating Anvil.

Run `anvil --help` before guessing.
