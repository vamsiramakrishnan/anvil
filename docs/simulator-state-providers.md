# Simulator state providers

The simulator (`@anvil/simulator`, ADR-0017) serves a contract's approved
operations with the contract's safety behaviour. By default its data is a
small seeded store: a few fixture records per resource, each with an id and a
status, dressed in bodies synthesized from the declared response schema. A
**state provider** replaces that store. Anvil keeps the surface and hands the
provider each call as one normalized request; the provider owns the records
and the query semantics. The decision is recorded in
[ADR-0028](adr/0028-simulator-state-providers.md).

| Anvil owns (the surface) | The provider owns (the state) |
| --- | --- |
| Which operations exist, and their paths and methods | Which records exist |
| Auth scopes per principal | What a filter, search, or sort means |
| Confirmation gate | What a create, update, or delete changes |
| Required idempotency keys and replay | Which domain errors apply (not found, conflict, invalid) |
| Injected faults (`throttle`, `outage`, `conflict`) | Pagination continuation (the cursor value) |
| Page size, page envelope, error status and body mapping | |
| The call trace | |

A call that fails a surface gate never reaches the provider. A keyed mutation
that repeats an earlier key is replayed by Anvil and never reaches the
provider either.

## Serve over HTTP

```sh
anvil simulate serve --contract ./bundle \
  --provider-cmd "python -m my_provider" \
  --port 0 --trace ./calls.jsonl
```

The first line on stdout is the bound URL, for example
`http://127.0.0.1:40123`. Diagnostics and the provider's stderr go to stderr.
The server runs until SIGINT or SIGTERM; it exits with status 1 if the
provider process dies.

The server answers each approved operation where a real client of that
protocol sends it, so any HTTP client of the real API can target it:

- A generated SDK: pass the URL as `base_url`.
- The generated MCP server or `anvil run`: set `ANVIL_BASE_URL` (or
  `--base-url`) to the URL. A contract with OAuth client-credentials auth
  still needs a token endpoint the runtime can reach; bearer and API-key
  contracts need only a token value.

| Option | Meaning |
| --- | --- |
| `--contract <path>` | Generated bundle directory, or its `air.yaml` |
| `--provider-cmd <command>` | Shell command that starts the provider. Omit it to serve the built-in seeded store. |
| `--provider-timeout <ms>` | Deadline for each provider request (default 30000) |
| `--host`, `--port` | Bind address (default `127.0.0.1`, port 0 picks a free one) |
| `--seed <n>` | Simulator seed: fault decisions and the built-in store derive from it |
| `--capability <id>` | Serve one discovered capability instead of the whole service |
| `--principal <id>` | Principal for requests that name none (default: the profile holding every scope, `admin`) |
| `--page-size <n>` | Page size when the contract lets Anvil derive none |
| `--trace <file>` | Append one JSON line per call |
| `--protocol-facade` | Serve SOAP, transcoded gRPC, and queue-bridged operations at their synthesized paths over HTTP+JSON (see below) |

### Which protocols are served

- **HTTP+JSON** operations (OpenAPI, Swagger, Discovery, Postman, OData, HAR,
  and gRPC methods with a `google.api.http` rule) are served at their
  declared path and method.
- **GraphQL** queries and mutations are served at one endpoint, as the
  runtime's GraphQL codec calls them: `POST` a GraphQL-over-HTTP body
  (`{"query", "operationName", "variables"}`) to the server URL, or to any
  path no other operation claims. The operation is found by `operationName`,
  then by the exact compiled document, then by the root field the document
  selects. Arguments are read from `variables`; inline literals are not
  read. A success is `200 {"data": {"<root field or alias>": ...}}`. A
  failure is `200 {"errors": [{"message": ..., "extensions": {"code": ...}}],
  "data": null}`, where `code` is the vendor code the contract maps (else
  Anvil's code). Each operation also answers at its synthesized
  `/graphql/<Type>/<field>` path, for a client that declares a protocol
  facade.
- **SOAP**, gRPC methods behind a JSON transcoder, and queue request/reply
  operations are not decoded natively. With `--protocol-facade`, the server
  serves their synthesized coordinates over HTTP+JSON, as the facade a client
  declares with `--protocol-facade` on the generated CLI or
  `ANVIL_PROTOCOL_FACADE` on the generated servers. Without the flag, the
  server refuses to start.
- **GraphQL subscriptions** and adopted **MCP tools** have no HTTP
  request/response form, and the server refuses to start with them.

A refusal names every unreachable operation and why. Use `--capability` to
serve a capability that leaves them out.

### Serve a profile of a full vendor spec

Compile the vendor's whole published spec under an exposure profile, approve
the profile's operations, and serve the bundle. The server answers only
approved operations inside the profile; every other path of the real API
returns `unsupported_operation`, so an agent sees the chosen subset while its
requests and responses follow the vendor's real contract.

```sh
anvil compile swagger-v3.v3.json --profile jira.profile.yaml \
  --manifest anvil.yaml --out ./jira
anvil approve ./jira --profile --reviewer alice@example.com
anvil simulate serve --contract ./jira --port 0 --trace ./calls.jsonl
```

A profile that selects every operation (`select: all`) serves the whole
approved contract. The profile format, its schema bounds, and measured
compile costs for five vendor specs are in
[Full vendor specs and exposure profiles](./SOURCE_FORMATS.md#full-vendor-specs-and-exposure-profiles).

### How a request is read

- **Principal.** The `X-Anvil-Principal` header, else a bearer token equal to
  a simulated principal id (`admin` holds every scope, `limited` holds none),
  else `--principal`.
- **Tenant.** The `X-Anvil-Tenant` header. Replay is scoped to principal and
  tenant.
- **Idempotency key.** From wherever the contract's idempotency carrier puts
  it (header, query, path, or body field; for GraphQL, a field of
  `variables`).
- **Body.** Read in the content type the operation declares, after the route
  is chosen: JSON; `application/x-www-form-urlencoded`, with each field typed
  by its schema and a repeated key read as an array; or `multipart/form-data`,
  where a file part (or a field declared as binary) becomes a base64 string,
  a JSON part is parsed, and a text part is typed by its schema. A body that
  does not decode is a `400` with `validation_error`.
- **Cookies.** Declared cookie parameters are read from the `Cookie` header.
- **Faults.** `X-Anvil-Fault: throttle | outage | conflict | slow` activates a
  named fault scenario for that request.
- **Confirmation.** Treated as given. The MCP server, CLI, and SDK refuse an
  unconfirmed mutation before sending it, and the wire carries no confirm
  field.
- **Cursor and page size.** From the contract's `cursorParam` and
  `pageSizeParam`, which are parameters, or request-body fields when the
  contract pages in the body (`pagination.in: body`, as Jira's
  `POST /rest/api/3/search/jql` sends `nextPageToken` and `maxResults`). An
  OData collection (Microsoft Graph) continues with `$skiptoken`, or with
  `$skip`. A requested size is clamped to the declared `maxPageSize`.

### How a response is written

- A paged operation's items go under the declared `itemsField` (or the first
  array property of the declared response), and a continuation under the
  declared `nextField` (default `next_cursor`). A `link` style continuation is
  a URL on the server's own origin carrying the cursor, which the same client
  can follow: `_links.next` for a contract that declares it (Confluence v2),
  or `@odata.nextLink` with `$skiptoken` for an OData collection declaring
  `$top`, `$skip`, or `$skiptoken` (a `$skip` in the request is dropped from
  the link, since the token covers it). A response declared as a bare array is served as
  one, with the continuation in a `Link: <...>; rel="next"` header.
- Other successes return the provider's `result` as the body, with a status
  the contract declares for an HTTP+JSON operation: `204` with no body when
  it declares 204 and the provider returns no `result` (or it declares no
  other success), else its first declared body-bearing status. Jira's
  `PUT /rest/api/3/issue/{issueIdOrKey}` declares 200 and 204, so it answers
  204 unless the provider returns the issue. An operation that declares no
  exact 2xx status gets 201 for a create and 200 otherwise.
- A `POST` to a literal segment under an item whose only declared success is
  204 (Jira's `POST /rest/api/3/issue/{issueIdOrKey}/transitions`) creates
  nothing, so the provider sees it as `kind: "action"`, not `create`.
- Errors use the contract's declared status for that error, and the body
  `{"error": {"code": "<vendor code or Anvil code>", "message": "..."}}`
  unless the provider supplied its own body.
- Every response carries `X-Request-Id`, the deterministic request id.

## Wire protocol (stdio JSON-RPC 2.0)

Anvil starts the provider with the shell command, writes requests to its
stdin, and reads responses from its stdout.

- **Framing.** One JSON-RPC 2.0 message per line, UTF-8, terminated by `\n`.
  A message must not contain a raw newline (standard JSON encoders escape
  them). Write each response as one line and flush.
- **Ids.** Anvil numbers its requests 1, 2, 3, and so on. A response carries
  the id of the request it answers. Responses may arrive in any order.
- **Stdout is the protocol.** Lines on stdout that are not JSON are ignored
  with a warning on Anvil's stderr. Log to stderr; Anvil forwards it.
- **Notifications** (messages without an id) from the provider are ignored.
- **Timeouts.** Each request has a deadline (`--provider-timeout`). A late
  answer is discarded, and that call fails with `upstream_timeout`.
- **Process death.** If the provider exits, every pending and later call
  fails with `upstream_unavailable`, the message names the exit code or
  signal and the tail of the provider's stderr, and `anvil simulate serve`
  exits with status 1.
- **JSON-RPC errors** (`{"error": {...}}` in place of `result`) mean the
  provider could not process the request. The call fails with
  `upstream_unavailable`. Report domain errors inside `result` instead (see
  below).

### `initialize`

Sent once, before any other request.

```json
{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
  "protocolVersion": 1,
  "simulator": {"name": "@anvil/simulator", "version": "0.1.0"},
  "serviceId": "tickets",
  "capabilityId": "tickets",
  "contractDigest": "3f1c...",
  "surfaceDigest": "9ab0...",
  "seed": 1,
  "operations": [
    {"operationId": "tickets.tickets.list", "toolName": "tickets_list_tickets",
     "kind": "list", "action": "list", "resource": "ticket",
     "method": "GET", "pathTemplate": "/tickets", "paged": true}
  ]
}}
```

`contractDigest` is the content hash of the AIR document being served, and
`surfaceDigest` is its surface-signature digest (ADR-0015). A provider built
for one contract can refuse another by comparing them.

The provider answers with the protocol version it speaks. Anvil refuses to
serve if it is not `1`.

```json
{"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}}
```

### `invoke`

One per call that passed the surface gates. `params` is the normalized
request:

```json
{"jsonrpc": "2.0", "id": 2, "method": "invoke", "params": {
  "requestId": "r1",
  "capabilityId": "tickets",
  "operationId": "tickets.tickets.list",
  "toolName": "tickets_list_tickets",
  "kind": "list",
  "action": "list",
  "resource": "ticket",
  "method": "GET",
  "pathTemplate": "/tickets",
  "params": {"path": {}, "query": {"status": "open"}, "header": {}, "cookie": {}},
  "body": null,
  "page": {"cursor": null, "size": 2},
  "principal": {"id": "admin", "role": "admin", "scopes": ["tickets:write"]},
  "tenantId": null,
  "idempotencyKey": null
}}
```

| Field | Meaning |
| --- | --- |
| `requestId` | `r<n>`, where n is the call's position in the simulator run. Deterministic for a given call sequence. |
| `kind` | `read`, `list`, `search`, `create`, `update`, `delete`, or `action`, from Anvil's effect classification (not the HTTP verb). |
| `action` | Anvil's finer verb: `get`, `list`, `search`, `create`, `update`, `replace`, `delete`, `send`, `approve`, `cancel`, and others. |
| `params` | Parameters by their wire names, split by location: `path`, `query`, `header`, and `cookie`. Values are typed per the parameter schema. |
| `body` | The request body with the contract's field names, or `null`. |
| `page` | Present (not `null`) exactly when the operation is paged. `cursor` is the value the caller passed back, `size` is the most items to return. |
| `principal` | The simulated caller, or `null` for an operation without auth. |
| `idempotencyKey` | The caller's key for a mutation that carries one, else `null`. |

`params.cookie` was added without changing `protocolVersion`: it is an extra
key, so a version 1 provider that ignores unknown keys is unaffected, and a
provider may rely on it being present (possibly empty) from this release on.

The provider answers with one of three shapes in `result`:

```json
{"ok": true, "result": {"id": "T-1", "title": "Ticket 1"}}
{"ok": true, "items": [{"id": "T-1"}, {"id": "T-3"}], "nextCursor": "2"}
{"ok": false, "error": {"code": "not_found", "upstreamCode": "TICKET_NOT_FOUND",
                        "message": "No ticket T-9"}}
```

- A paged request (`page` not null) needs `items`, at most `page.size` of
  them, and `nextCursor` (a string, or `null` on the last page). More items
  than `page.size` is refused with `schema_mismatch`: trimming them would
  lose records the cursor could not reach.
- Any other success returns `result` (any JSON value).
- An error names `code`, one of Anvil's error codes: `validation_error`,
  `auth_required`, `permission_denied`, `not_found`, `conflict`,
  `rate_limited`, `upstream_timeout`, `upstream_unavailable`,
  `unsupported_operation`, `policy_denied`, and the rest of the taxonomy in
  `@anvil/air`. An unknown code becomes `unknown_upstream_error`. Optional
  fields: `upstreamCode` (the vendor's own code), `message`, `status` (an
  HTTP status that overrides the mapping), and `body` (a vendor error body
  served verbatim).

Anvil maps an error onto the operation's declared errors: an entry whose
vendor code equals `upstreamCode` wins, then an entry with the same Anvil
code. That entry supplies the HTTP status and the vendor code in the default
body. Without a declared entry, the status follows the usual convention (404
for `not_found`, 409 for `conflict`, 400 for `validation_error`, 429 for
`rate_limited`, and so on).

### `shutdown`

Sent when the simulator stops. Answer, then exit. Anvil closes stdin after
the answer, and terminates a provider that is still running 2 seconds later.

```json
{"jsonrpc": "2.0", "id": 9, "method": "shutdown", "params": {}}
{"jsonrpc": "2.0", "id": 9, "result": null}
```

### A minimal Python provider

```python
import json, sys

ROWS = [{"id": f"T-{n}", "title": f"Ticket {n}"} for n in range(1, 6)]

def answer(req):
    if req["kind"] == "list":
        start = int(req["page"]["cursor"] or 0)
        end = start + req["page"]["size"]
        return {"ok": True, "items": ROWS[start:end],
                "nextCursor": str(end) if end < len(ROWS) else None}
    if req["kind"] == "read":
        row = next((r for r in ROWS if r["id"] == req["params"]["path"].get("ticket_id")), None)
        if row is None:
            return {"ok": False, "error": {"code": "not_found", "message": "no such ticket"}}
        return {"ok": True, "result": row}
    return {"ok": False, "error": {"code": "unsupported_operation"}}

for line in sys.stdin:
    msg = json.loads(line)
    method = msg["method"]
    if method == "initialize":
        result = {"protocolVersion": 1}
    elif method == "invoke":
        result = answer(msg["params"])
    else:  # shutdown
        result = None
    print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)
    if method == "shutdown":
        break
```

A client that starts the server and reads the URL:

```python
import subprocess
from my_generated_sdk import TicketsClient

server = subprocess.Popen(
    ["anvil", "simulate", "serve", "--contract", "bundle",
     "--provider-cmd", "python provider.py", "--trace", "calls.jsonl"],
    stdout=subprocess.PIPE, text=True)
url = server.stdout.readline().strip()
client = TicketsClient(base_url=url, token="admin")
page = client.list_tickets(status="open")
server.terminate()
server.wait()
```

## Call trace

With `--trace <file>` (or `trace` on `SimulatorOptions`), every call appends
one JSON line. The file is appended to, never truncated. No clock is
recorded, so two runs of the same call sequence write the same trace.

The file is opened when the server starts, so a path that cannot be written
(for example, a missing parent directory) stops `anvil simulate serve` before
it binds. If a later write fails, the call's response is served unchanged:
the call has already happened, and a provider may have committed it. The
failure is reported on stderr, and the response carries an
`X-Anvil-Trace-Error` header describing it.

```json
{"schema": "anvil.simulator.trace/v1", "seq": 3, "requestId": "r3",
 "transport": "http", "tool": "tickets_get_ticket", "operationId": "tickets.tickets.get",
 "request": {"method": "GET", "path": "/tickets/T-404", "query": {}, "headers": {}, "body": null},
 "normalized": {"requestId": "r3", "kind": "read", "params": {"path": {"ticket_id": "T-404"}, "query": {}, "header": {}}},
 "provider": {"ok": false, "error": {"code": "not_found", "upstreamCode": "TICKET_NOT_FOUND"}},
 "result": {"ok": false, "error": {"code": "not_found", "message": "No ticket T-404",
            "wire": {"status": 404, "body": {"error": {"code": "TICKET_NOT_FOUND", "message": "No ticket T-404"}}}}},
 "status": 404,
 "response": {"error": {"code": "TICKET_NOT_FOUND", "message": "No ticket T-404"}}}
```

(`normalized` is abbreviated here; the file carries the full request.)

| Field | Meaning |
| --- | --- |
| `seq`, `requestId` | Call position, and the id the provider and the `X-Request-Id` header saw |
| `transport` | `http` or `in_process` |
| `request` | What the agent sent: the HTTP method, path, query (each value an array), selected headers (declared header parameters and `X-Anvil-*`, never `Authorization`), and body. In process: the tool input and context. |
| `normalized` | What the provider was asked, or `null` when a surface gate answered first (auth, confirmation, idempotency, fault, replay, unknown route) |
| `provider` | What the provider answered, `{"transportError": "..."}` when it could not answer, or `null` |
| `result` | Anvil's result before wire encoding |
| `status`, `response` | The final HTTP status and body |

## In process (TypeScript)

```ts
import { Simulator, simulatorDefinitionFor, StdioStateProvider, JsonlTrace } from "@anvil/simulator";

const def = simulatorDefinitionFor(air);
const provider = await StdioStateProvider.start(
  { command: "python provider.py", timeoutMs: 10_000 },
  new Simulator(air, def).initializeParams(),
);
const sim = new Simulator(air, def, { provider, trace: new JsonlTrace("calls.jsonl") });
const result = await sim.invokeAsync("tickets_list_tickets", { status: "open" });
await provider.close();
```

Any object with an `invoke(request)` method that returns a response (or a
promise of one) is a provider, so a fixture database or a record and replay
store can run in process. A simulator built with a provider serves through
`invokeAsync` (or `call`, which also returns the normalized request and the
raw answer); the synchronous `invoke` refuses. Without a provider, `invoke`
and `invokeAsync` serve the built-in store and return the same results as
before this seam existed.
