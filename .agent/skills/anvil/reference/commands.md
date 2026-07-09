# anvil commands

### `anvil compile`  *(mutates)*
`anvil compile <spec> [--manifest f] [--service id] [--out dir] [--endpoint url]`

Compile a spec into a full tool bundle (CLI + MCP + skill + deploy).

Parses OpenAPI/Swagger, classifies effects and idempotency, applies the manifest, validates safety, and writes the bundle. Non-idempotent mutations are escalated to review_required — they are not exposed until approved.

### `anvil inspect`
`anvil inspect <dir|air.yaml> [--json]`

Show the operation catalog and each operation's safety posture.

Read-only. Use before approving to see effect, risk, idempotency, retry-safety, and state.

### `anvil lint`
`anvil lint <dir|air.yaml>`

Show safety diagnostics; exit non-zero if there are errors.

Surfaces unproven idempotency, missing confirmation, duplicate names, and incoherent retry policy.

### `anvil approve`  *(mutates)*
`anvil approve <dir|air.yaml> <operation-id...>`

Approve operations so they are exposed by the generated artifacts.

Only approved operations appear in the MCP server, CLI catalog, and compiled runtime manifest. Approve deliberately, after inspecting risk.

### `anvil run`  *(mutates)*
`anvil run <dir|air.yaml> <resource> <action> [flags]`

Invoke an operation through the safety runtime.

Supports --dry-run, --confirm, --idempotency-key, --schema, --examples, --json, --trace. Unsafe mutations refuse without --confirm.

### `anvil serve`
`anvil serve mcp <dir>`

Serve the generated MCP server over stdio.

Boots the MCP server for local agent use. The same server deploys to Cloud Run for remote use.

### `anvil package`
`anvil package skill <dir>`

Locate and verify the portable skill package.

The skill is also served over MCP as anvil://skill/<service>/... resources.

### `anvil deploy`
`anvil deploy cloud-run <dir> [--env prod]`

Print the Cloud Run deployment plan for a bundle.

Anvil generates the deploy artifacts (Dockerfile, service YAML, env/secret contracts); it does not hold cloud credentials.
