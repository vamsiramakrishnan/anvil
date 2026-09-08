# Business calibration

Owned synthetic contracts cover returns across three systems, order amendments
with revision checks, and account access with manager and trusted human approval.

The source AIR files are explicitly approved fixtures. Their servers point to
an unused loopback port; tests supply independent backend implementations.
These are not production source approvals.

Build and inspect the bundle with the commands in
[Business capability execution](../../docs/business-capabilities.md). Run the
actual MCP, CLI, CLI-over-MCP, TypeScript, Python, Go, and Java interfaces:

```sh
pnpm build
ANVIL_FUZZ_REQUIRE_SDKS=true pnpm exec vitest run \
  packages/harness/src/business/business.test.ts \
  packages/harness/src/business/serving.test.ts
```

Each client gets fresh fixture state. Backend state supplies the oracle;
generated response shapes do not establish business success. The account-access
fixture's reviewer approves only these synthetic effects.

For a new domain, author business inputs and results first. Bind each fact and
effect to its authoritative reviewed source. Add independent invariants and
recovery cases before approving actions. Skills guide selection, clarification,
and escalation; deterministic API choreography belongs in the private plan.
