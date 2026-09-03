# Agent-platform targets

A certified bundle exposes one contract. `anvil target <profile> <dir>`
projects it onto a specific agent platform's connector shape — a Claude MCP
config, an OpenAI Responses API tool, an MCP registry listing, a Gemini
Enterprise connector — without changing the contract itself. Every profile is
registered in `@anvil/targets` (`listProfiles()` in
[`packages/targets/src/registry.ts`](../packages/targets/src/registry.ts)),
so a new platform is a new profile module, never a CLI rewrite.

Every profile shares three properties:

- **Pure projection.** Output is a deterministic function of the compiled
  contract (AIR) plus the profile's own config. The same inputs always
  produce byte-identical files.
- **No network calls, ever.** Anvil never registers, publishes, or
  authenticates against a platform on your behalf. Every kit that would
  otherwise require a live call (a registry publish, a connector import)
  emits a request template or a plan instead, and says so.
- **Validated before it's written.** `anvil target` refuses to write any
  file when validation reports an error — a stale target subtree is never
  half-updated.

Run `anvil target <profile> --help` for a subcommand's exact flags.

## Gemini Enterprise

```bash
anvil target gemini-enterprise <dir> \
  --surface custom-mcp --server-auth oauth \
  --endpoint https://your-host/mcp --project my-proj --location global \
  --engine my-engine --idp entra --tenant <tenant> \
  --oauth-scope api://anvil-mcp/mcp.invoke \
  --inbound-issuer https://login.microsoftonline.com/<tenant>/v2.0 \
  --inbound-audience api://anvil-mcp
```

Registers a custom MCP server (`data_source = custom_mcp`) over the
StreamableHTTP transport, with an action-selection budget and either a
`custom-mcp` (console-first data-store) or `agent-gateway` (Agent Registry +
Agent Gateway) registration surface. See
[`packages/targets/src/gemini-enterprise.ts`](../packages/targets/src/gemini-enterprise.ts)
and `docs/backtesting/GEMINI_ENTERPRISE_VALIDATION.md` for what was verified
against a live platform.

## Claude

```bash
anvil target claude <dir> \
  --endpoint https://your-host/mcp --server-auth oauth \
  --oauth-authorization-url https://idp.example/authorize \
  --oauth-token-url https://idp.example/token \
  --oauth-scope api://anvil-mcp/mcp.invoke \
  --inbound-issuer https://idp.example/ --inbound-audience api://anvil-mcp \
  --oauth-client-id-env ANVIL_OAUTH_CLIENT_ID \
  --oauth-client-secret-env ANVIL_OAUTH_CLIENT_SECRET
```

Emits an `mcpServers` config fragment for **both** transports Claude
supports — stdio (`anvil serve mcp <dir>`, the same deployed unit as every
other surface) and streamable-http — plus `permissions.json`, a per-tool
`"ask" | "allow"` hint derived from contract-level confirmation. When
`--server-auth oauth`, it also emits `connector-manifest.json`, the shape a
remote MCP server is registered under in a connector directory. The OAuth
client-credential flags accept only an **environment-variable NAME**
(`--oauth-client-id-env`, `--oauth-client-secret-env`) — never a secret
value; passing a value that looks like one is a validation error
(`target/embedded_secret_value`).

## OpenAI

```bash
anvil target openai <dir> \
  --endpoint https://your-host/mcp --server-auth oauth \
  --oauth-authorization-url https://idp.example/authorize \
  --oauth-token-url https://idp.example/token \
  --oauth-scope api://anvil-mcp/mcp.invoke \
  --inbound-issuer https://idp.example/ --inbound-audience api://anvil-mcp
```

Emits `responses-tool.json`, a Responses API `type: "mcp"` tool declaration
(`server_url`, `require_approval`), plus `function-tools.json`, a
`type: "function"` fallback — one function per approved operation, with its
JSON Schema drawn straight from AIR — for clients that cannot attach a
remote MCP server.

`require_approval` is derived per operation from contract-level confirmation
(`confirmation.required` / `confirmation.humanApproval`): a confirmation-
required operation is **always** `"always"`, never downgraded to `"never"` by
anything platform-specific. This is a safety property, not a default —
`packages/targets/src/mcp-connector.ts`'s `requireApprovalTier` is the one
place it's decided, and `tools/mutation/mutants.json`'s
`targets/approval-never-downgraded` mutant proves a test would catch a
regression.

## MCP registry

```bash
anvil target mcp-registry <dir> \
  --endpoint https://your-host/mcp --server-auth none \
  --name io.github.<owner>/<slug> --registry-version 1.0.0 \
  --repository-url https://github.com/<owner>/<repo>
```

Emits `server.json` (`name`, `description`, `version`, `remotes`) and
`publish-plan.json` — ordered steps for a human operator, never executed.
Anvil holds no registry credentials and never calls a publish endpoint. No
copy of the registry's published JSON Schema was available to verify
against offline, so `server.json`'s core fields are the documented minimum;
Anvil-specific detail with no home in that schema is namespaced under
`_meta.anvil` rather than invented as a top-level field. Review the current
registry schema before submitting.

## What every kit validates

- **Transport.** A public HTTP endpoint (when the profile needs one) must be
  a credential-free HTTPS URL, without a query string or fragment, and not a
  private/local address.
- **OAuth completeness.** When server auth is `oauth`, the authorization
  URL, token URL, at least one MCP-API scope, the inbound issuer, and the
  inbound audience are all required and shape-checked.
- **No embedded secrets.** Every OAuth client-credential field is typed as
  an environment-variable NAME. Validation also scans the actual string for
  a value that looks like a credential (a JWT, a common API-key prefix, a
  PEM key, a long high-entropy blob) and refuses it even if it slipped past
  the type — `target/embedded_secret_value`.
- **Approval never loosens.** For OpenAI, a confirmation-required operation
  can only ever validate as `"always"`; a mapping that would downgrade it is
  `target/approval_downgraded`.

## Adding a platform

A new platform is a new profile module in `packages/targets/src/` (its own
config type, `generate*TargetKit`, `validate*Target`), one line added to
`listProfiles()` in `registry.ts`, and one CLI subcommand file under
`packages/cli/src/commands/target/`. The Gemini Enterprise profile is the
most fully worked example — a much larger surface (Terraform overlays,
mutable Agent Gateway state, an atomic-install write path) than a
remote-MCP-only platform needs, but every piece of it stands on the same
`AgentPlatformTargetProfile` model in `packages/targets/src/model.ts`.
