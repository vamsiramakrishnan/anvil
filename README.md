# Anvil

**You have an API. You want an agent to use it without breaking anything.**

Point Anvil at a spec you already have and it gives you three tools that agree
with each other — a typed **CLI**, an **MCP server**, and an agent **skill** —
plus the guardrails that stop an agent doing something you didn't sanction.

```bash
pnpm anvil agentify examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml --service payments --out generated/payments
```

That's it. You now have working tools and a review queue.

> The highest compliment isn't "it generated a lot of code." It's
> *"the agent stopped guessing."*

---

## What you actually get

### Your agent stops guessing what a call does

Wire an agent to an API by hand and it has to infer: is this safe to retry?
Will it charge the card twice? Does a human need to approve it? Those answers
live in someone's head, not in the tool.

Anvil answers them in the tool itself. Every operation carries whether it reads
or writes, how bad it is if it goes wrong, whether repeating it is safe, and
whether it needs confirmation — and the CLI, the MCP server, and the skill all
report the *same* answer, because they're generated together. They can't drift
apart as the API changes.

### Nothing reaches the agent until you say so

Compiled operations start life unexposed. You read the risk, then approve.

```bash
anvil assess generated/payments          # what's ready, and why the rest isn't
anvil capability approve generated/payments payments.refunds
```

Unapproved operations aren't hidden and aren't quietly exposed — the skill lists
them as **not callable**, so the agent knows they exist and knows not to try.

### Your customers don't get charged twice

A refund that isn't provably safe to repeat is never auto-retried, no matter
what the network did. And it refuses to run at all without explicit confirmation:

```json
{ "error": { "code": "confirmation_required",
  "message": "This operation creates an irreversible financial mutation.",
  "required_flags": ["--confirm", "--idempotency-key"] } }
```

That refusal is the feature. Try anything for real with `--dry-run` first — it
shows you the exact request that would go out, with secrets redacted.

### Your agent doesn't drown in your API

A big estate compiles to thousands of tools. An agent reading that list burns
its whole context before it finds the one call it needs.

Anvil measures what every tool costs an agent to read, then serves capability
lanes instead of a flat list — the agent opens the one it needs. On a
100-operation service that's **7.4× fewer tokens** to reach an operation
(29,300 → 3,956 median), for one extra round trip.

```bash
anvil disclosure generated/payments      # where the context budget actually goes
```

It names the specific fields responsible, so you get a ticket you can close
instead of "make your API agent-friendly." Responses are handled the same way:
page sizes are solved against a token budget rather than fetched-then-truncated,
and an agent can ask for fewer fields with a JMESPath projection.

### You can prove all of it, per bundle

Not a claim in this README — something each generated bundle demonstrates about
itself, with evidence bound to its content hash:

| Command | What it proves |
|---|---|
| `anvil selftest` | Boots the real MCP server and calls every approved tool over the real transport — arguments reach the wire faithfully, confirmation gates refuse *before* side effects |
| `anvil conformance` | The skill, CLI, and MCP tool list name the same operations and document the exact posture the runtime enforces |
| `anvil simulate` | Drives the whole safety matrix through a deterministic simulator, then **breaks each safety control and proves the surface notices** |
| `anvil certify` | Every generated surface agrees byte-for-byte with the canonical model |
| `anvil benchmark` | Scores whether an agent can actually discover and call your tools |

Evidence goes stale when the bundle changes, and `anvil publish` fails closed
for production without fresh proof on every lane.

---

## Fix the API's problems without forking it

Vendor specs are incomplete. You don't fix that by editing generated code or
maintaining a fork — you declare what the spec left out, in one file, and
recompile. All three surfaces move together.

```yaml
# anvil.yaml
operations:
  sendSms:
    idempotency: { strategy: required_request_key }   # "please don't re-run" becomes enforced
  get_refund_by_id:
    description: Retrieve one refund by its refund id.  # fix a vendor's duplicate docs
  doTransition:
    name: { resource: issue, verb: transition }        # a name an agent can route on
query_templates:
  branch_names:                     # a constrained read instead of raw SQL passthrough
    operation: run_query
    template: "SELECT name FROM accounts WHERE branch = '{branch}' LIMIT 10"
    target_param: sql
    params: { branch: { schema: { type: string, pattern: "^[A-Z0-9]+$" } } }
    read_only: true
```

Don't know what's missing? `anvil refine run` finds the gaps and proposes fixes,
and `anvil enrich` goes further — it reads the MCP servers GitHub, GitLab,
Confluence, Notion, and Postman already publish to gather evidence about your
own API. Both only ever *propose*. Loosening a safety rule needs strong evidence;
tightening one is cheap.

## Where your API lives

Anvil reads **OpenAPI 3.x**, **Swagger 2.0**, **GraphQL SDL**, **gRPC/proto3**,
**SOAP/WSDL**, **Google Discovery**, **OData v2/v4**, and **Postman
Collections** — all into the same model, so everything above works the same
regardless of protocol.

If your APIs live behind a gateway, Anvil inventories the whole estate first.
Support differs by vendor and the differences are real: run
`anvil estate support --json` before preparing an export.

## Next steps

- **[Quickstart](apps/docs/src/content/docs/start/quickstart.md)** — a real bundle in five minutes, no cloud account
- **[Operating Anvil](apps/docs/src/content/docs/guides/operating-anvil.md)** — the day-to-day loop
- **[Cookbooks](apps/docs/src/content/docs/cookbooks/)** — install, handle a confirmation gate, import a gateway estate, respond to drift
- **[Commands](apps/docs/src/content/docs/guides/commands.md)** — every command, generated from the CLI itself

**Driving Anvil from an agent?** It ships a skill for itself:
[`skills/anvil/SKILL.md`](skills/anvil/SKILL.md), with adapters for
[Claude Code](CLAUDE.md), [Codex](AGENTS.md), and Antigravity.

## Under the hood

Anvil is a compiler, not a framework. Everything you touch — CLI, MCP server,
skill, deploy artifacts — is a generated view of one canonical model, so the way
to change any of it is to change the model and recompile.

The deployed unit is just the MCP server: a thin, stateless service. Nothing on
the hot path parses a spec or runs an LLM.

If you want the internals: [architecture](docs/ARCHITECTURE.md),
[product boundary](docs/PRODUCT_BOUNDARY.md), [glossary](docs/GLOSSARY.md), and
[ADRs](docs/adr/). Built library-first — OpenAPI parsing, Zod, the MCP SDK,
Vitest, Biome — so Anvil only owns the Anvil-specific layer.

## License

Apache-2.0.
