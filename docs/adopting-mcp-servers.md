# Adopting an existing MCP server

Anvil's usual direction is spec → surfaces. `anvil adopt` is the other one: a
server is already serving tools to agents, and the question is what those tools
actually mean.

```bash
anvil adopt https://example.com/mcp --header 'Authorization: Bearer ${TOKEN}' --out adopted/
anvil adopt "node ./my-server.js" --out adopted/       # stdio: a command line
```

It connects, captures the advertised tools, and lowers each one to an AIR
operation. It never calls a tool and never regenerates the provider's server.

## Why this is worth doing

MCP's tool contract carries a name, a description, an input schema, and
optional hints. It carries **no effect kind, no idempotency, no confirmation
semantics**. A server exposing `delete_users` beside `get_users` advertises
them identically, and every agent downstream has to guess from the name.

Anvil refuses to inherit that ambiguity. Absent a `readOnlyHint`, a tool is
classified as a **non-idempotent mutation that requires confirmation and is
never auto-retried** — unknown side effect beats assumed safety. The report then
tells you how much of the classification was Anvil's caution rather than the
server's declaration, because those are very different facts:

```
4 of 4 tool(s) require confirmation; 4 are classified as mutations.
4 tool(s) carried no MCP annotations at all — those are classified
conservatively (mutation, confirm, never auto-retry) because the server states
no effect, idempotency, or confirmation semantics.
```

That second line is the useful one. It is not a complaint about the server; it
is a measurement of how much an agent has been guessing.

## What it writes

| File | What it is |
| --- | --- |
| `mcp-surface.json` | The content-addressed capture — tools, schemas, server identity, digest |
| `air.yaml` / `air.json` | One AIR operation per tool, with its safety classification |
| `capabilities.json` | Capability contracts derived from the adopted surface |
| `surface-signature.json` | The signature over the approved tools, for drift comparison |
| `adoption-plan.json` | What each mode would emit |

The digest excludes the endpoint address, so the same surface served from
staging and production has the same digest — which is what makes an adoption
comparable over time.

Then read it the ordinary way: `anvil inspect adopted/`.

## Modes

`--mode` records what an eventual build would emit. It does not change what
`adopt` captures.

- **`adopt`** (default) — reference the provider's endpoint directly. No server
  is generated.
- **`facade`** — Anvil's policy and runtime controls sit in front of the
  provider's server.
- **`replace`** — generate a fresh MCP server from the upstream API. Requires
  the upstream API source as well as the captured surface.

## Worked example: Moodle

Moodle publishes no OpenAPI. Its web services are one endpoint with a selector
— `POST /webservice/rest/server.php?wsfunction=…` — so all ~800 functions share
a single path, and Anvil's path-keyed model cannot hold them (importing a
Postman collection of them raises `postman_endpoint_collision` for every request
after the first).

The [`webservice_mcp` plugin](https://github.com/onbirdev/moodle-webservice_mcp)
solves the harder half: it reads Moodle's own `external_function_info()`
parameter and return descriptions and converts them to JSON Schema, one MCP tool
per function. Point Anvil at it:

```bash
anvil adopt 'https://moodle.example.com/webservice/mcp/server.php?wstoken=…' --out adopted/moodle
```

The endpoint's token stays out of the report — a query-carried credential is
never echoed back.

**What you will see is the point.** Every function comes back as an
unclassified mutation requiring confirmation — including `core_user_get_users`,
which is obviously a read. That is not Anvil being unhelpful. Moodle *declares*
read-vs-write in `db/services.php`:

```php
'core_user_get_users' => [
    'classname'   => '…',
    'type'        => 'read',        // ← read | write
    'capabilities'=> 'moodle/user:viewalldetails',
],
```

and the plugin's tool definition does not carry it. `type` and `capabilities`
map directly onto MCP's `readOnlyHint` and onto AIR's `auth.scopes`, so passing
them through would let every read classify correctly and every write carry its
required capability. Until then, conservative is the only honest answer, and the
adoption report says so out loud rather than quietly guessing.

If you want the full generated surface — CLI, MCP server, skill, and the four
client SDKs — rather than a classification of someone else's server, Moodle
needs a path per function. Give it one with a gateway rewrite
(`/moodle/{wsfunction}` → `?wsfunction={wsfunction}`) and compile the resulting
OpenAPI; that is the same synthetic-path device Anvil already uses to model
SOAP, where every operation also shares one endpoint.

## What adoption does not give you

An adopted AIR describes what a server exposes. It is not a compiled bundle:
the operations carry `sourceRef.kind: "mcp"` and no HTTP coordinates, so
generating a runtime from them would produce a client with nothing to call.
That is what `--mode facade` and `--mode replace` are for, and neither emits a
runtime today. Adoption is a review artifact — a truthful account of a surface —
and that is deliberately where it stops.
