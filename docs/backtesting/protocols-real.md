# Real GraphQL & gRPC backtests

The `graphql/`, `grpc/`, and `soap/` examples in the repo are small, hand-authored
teaching fixtures (~10 types each). This round ran the two non-REST adapters
against **real, large, published schemas** that also have a mature MCP server to
compare against — the same backtest bar as the REST systems. Three systemic
adapter bugs surfaced, all fixed.

## What was run

| System | Format | Real source | Size | Reference MCP | Result |
| --- | --- | --- | --- | --- | --- |
| GitHub GraphQL | GraphQL SDL | `docs.github.com/public/fpt/schema.docs.graphql` | 1.5 MB, 1,752 types, 299 ops | `github/github-mcp-server` (official) | **bug #20, #21** |
| Linear | GraphQL SDL | `linear/linear` SDK `schema.graphql` | 1.2 MB, 611 ops | `mcp.linear.app` (official) | clean after fixes |
| Temporal | gRPC proto3 | `temporalio/api` `workflowservice/v1/service.proto` | 121 rpc | `temporal-mcp` (community) | naming ✓, **bug #22** |
| etcd | gRPC proto3 | `etcd-io/etcd` `etcdserverpb/rpc.proto` + 3 imports | 42 rpc, multi-file | (no mature MCP) | multi-file proof |

## The three systemic bugs

### #20 — real GraphQL schemas hung the compile (gigabytes on serialize)
GitHub's 1,752-type schema timed out at 3 minutes. `parseSource` fully
dereferences the adapter output, turning a deeply recursive GraphQL schema
(`User → Repository → … → User`) into a massively-shared object graph — compact
in memory but exploding to gigabytes when `JSON.stringify` expands the sharing.
`bundleDocument` is supposed to re-collapse each named type to a `$ref`, but it
re-identifies inlined copies **by `title`**, and the protocol adapters
(GraphQL/gRPC/WSDL/Discovery) emitted named schemas with no `title`. Fixed by
stamping `title: <name>` on every adapter-produced named schema at the one seam
they share (`stampSchemaTitles` in parse.ts) — `airToJson` went from *hung* to
**54 ms / 4.2 MB**. See `deficiencies.md` #20.

### #21 — synthetic-namespace paths doubled the tool names
GraphQL lowers every field to `/graphql/Mutation/<field>`. The naming pass
treated `Mutation` as the resource and a field that merely *contains* a vocab
verb (`acceptEnterpriseAdministratorInvitation` contains "accept";
`issueFigmaFileKeySearch` ends "search") as a trailing verb — so every field
collapsed onto the `Mutation`/`Query` wrapper, collided, and disambiguation
re-appended the field name, doubling the tool name
(`..._accept_..._invitation_accept_..._invitation`). Fixed by firing the
trailing-verb rule only on a **bare** single-word verb segment (`/field/search`),
not a whole multi-word operation name. See `deficiencies.md` #21.

### #22 — gRPC message types imported from another file didn't resolve
Real services split a method's request/response messages into sibling protos
(Temporal's `WorkflowService` methods take `StartWorkflowExecutionRequest` from
`request_response.proto`). The adapter parsed only the entrypoint file, so those
bodies compiled to an opaque `body` stub. Added `resolveImport` to `adaptProto`:
`import`ed files are loaded into the same protobuf root (transitively) from the
snapshot — the exact multi-file contract Anvil already honours for OpenAPI
`$ref`s (same-snapshot bytes only, never the network). Proven on etcd's real
4-file proto: `Put` now resolves `key,value,lease,prev_kv,…` and the imported
`KeyValue` message resolves its real fields. An unresolvable import still
degrades gracefully. See `deficiencies.md` #22.

## Naming comparison — the payoff

Once #20/#21 were fixed, Anvil's GraphQL-derived tool names land **exactly** on
the reference MCP's hand-written ones:

| GitHub GraphQL field | Anvil `mcp.toolName` | github-mcp-server tool |
| --- | --- | --- |
| `createIssue` | `github_gql_create_issue` | `create_issue` ✅ |
| `addComment` | `github_gql_add_comment` | `add_issue_comment` ✅ |
| `createPullRequest` | `github_gql_create_pull_request` | `create_pull_request` ✅ |
| `mergePullRequest` | `github_gql_merge_pull_request` | `merge_pull_request` ✅ |
| `deleteRef` | `github_gql_delete_ref` (**destructive**) | (write) ✅ |

Temporal is the same story against `temporal-mcp`:
`StartWorkflowExecution → temporal_start_workflow_execution` (≈ `start_workflow`),
`TerminateWorkflowExecution → …_terminate_…` (**destructive**),
`ListWorkflowExecutions`/`QueryWorkflow`/`DescribeWorkflowExecution` → reads.
The proto→tool mapping a human wrote by hand is what Anvil derives mechanically.

## Note: Range-style reads
etcd names its read RPC `Range` (a range scan), which isn't a recognised read
verb, so Anvil conservatively classifies it a mutation — corrected by a manifest,
not a compiler change (unknown verb → mutation is the safe default). This is the
gRPC analogue of Jira's `POST /search` finding: safety defaults to conservative,
enrichment refines.
