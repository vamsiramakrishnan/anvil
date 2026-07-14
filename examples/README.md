# Anvil examples — one pipeline, five protocols

Each directory here is a **complete, diverse API** plus the Anvil manifest that
enriches the semantics its source format cannot express. They exist so you (or an
agent like Claude Code) can drive Anvil end to end — compile → inspect → run
against a generated **mock simulator** — without touching a real upstream.

| Example | Format | Source | Highlights |
| --- | --- | --- | --- |
| `payments/` | OpenAPI 3.x | `openapi.yaml` | Financial refunds, idempotency keys, workflows |
| `salesforce/` | OpenAPI 3.x | `openapi.yaml` | CRM accounts/contacts, per-object risk posture |
| `graphql/`  | GraphQL SDL | `schema.graphql` | Queries→reads, `checkout` (financial), `cancelOrder` (destructive) |
| `grpc/`     | gRPC / proto3 | `orders.proto` | `Get*`/`List*`→reads, `PlaceOrder` (financial), maps/enums/nested messages |
| `soap/`     | SOAP / WSDL 1.1 | `bank.wsdl` | `Get*`/`List*`→reads, `TransferFunds` (financial), `CloseAccount` (destructive) |
| `sap/`      | OData v2 (`$metadata`/EDMX) | `metadata.edmx` | SAP business-partner entities, composite keys, `sap:deletable=false` annotations |

For **real** enterprise specifications (NetSuite SOAP, live OData v2/v4, gRPC)
compiled through the same pipeline, see the backtest corpus
([`../docs/backtesting/ENTERPRISE_SYSTEMS.md`](../docs/backtesting/ENTERPRISE_SYSTEMS.md)).

All of these compile through the **same** normalize → classify → validate → generate
pipeline. Non-REST protocols are *lowered* into a pre-dereference OpenAPI 3.0
document by the adapters in `packages/compiler/src/protocols/`, so effect,
idempotency, retry-safety, confirmation, and every generated artifact behave
identically regardless of the wire format.

## The end-to-end loop

```bash
pnpm install && pnpm build
alias anvil='node packages/cli/dist/bin-anvil.js'

# 1. Compile a protocol source + its manifest into a full bundle.
anvil compile examples/grpc/orders.proto \
  --manifest examples/grpc/anvil.yaml --service orders --out generated/orders

# 2. Read every operation's effect, risk, and idempotency posture.
anvil inspect generated/orders
#   orders GetOrder    read                 approved
#   orders PlaceOrder  create/financial     approved ⚠   (confirmation + idempotency key)
#   orders CancelOrder create/destructive   approved ⚠

# 3. Boot the generated mock simulator and exercise it — no real backend.
PORT=8099 ANVIL_MOCK_SCENARIO=list_orders_success node generated/orders/mock/server.mjs &
curl -s localhost:8099/ | jq        # schema-faithful, seeded response body

# 4. Dry-run a read through the safety runtime — note the real gRPC wire path.
anvil run generated/orders GetOrder list --id o_123 --dry-run
#   → { "url": "/acme.orders.v1.OrderService/GetOrder", ... }

# A financial mutation refuses without --confirm and its idempotency key.
anvil run generated/orders PlaceOrder create \
  --body '{"customer_id":"c1","line_items":[],"payment_token":"tok"}' --dry-run
```

Use `anvil run generated/orders catalog` to list every operation's invocation
form, and `anvil run generated/orders explain <op>` for one operation's full
contract (inputs, risk, idempotency, retry posture).

Swap `examples/grpc/orders.proto` for `examples/graphql/schema.graphql` or
`examples/soap/bank.wsdl` (with the matching `--manifest`) — the loop is
identical. `anvil agentify <spec> --manifest <manifest>` is the one-shot front
door that locks the source, compiles, assesses, and proposes capabilities.

## What the adapters do (and don't) infer

- **Effect is conservative.** A mutation whose idempotency cannot be proven from
  the source is left `review_required` — it is never silently exposed. The
  manifest is where you declare idempotency keys, confirmation, and approvals
  (see each `anvil.yaml`).
- **Schemas are faithful.** Nested messages/types, enums, `repeated`/list fields,
  proto `map<>`, and XSD `complexType`/`simpleType` restrictions all lower into
  JSON Schema and drive the generated mock payloads.
- **Names come from the source.** gRPC keeps its `/package.Service/Method` wire
  path; GraphQL fields are grouped under `Query`/`Mutation`; SOAP operations
  under their `portType`.
