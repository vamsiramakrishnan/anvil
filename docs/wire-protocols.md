# Wire protocol support

Anvil can compile more source formats than it can execute natively.

The distinction is strict:

1. A source adapter parses a document and lowers operations into AIR.
2. A wire binding tells the runtime how to encode a real request.
3. An operation without a supported binding is not executable.

Compilation does not turn an unsupported transport into HTTP.

## Current support

| Protocol | Runtime status | Request shape | Refused modes |
| --- | --- | --- | --- |
| HTTP with JSON | Supported | Method, URL, headers, query, and a JSON, form-urlencoded, or multipart body from AIR | Any other request body content type, refused before a credential is read (see [Request bodies](#request-bodies)) |
| GraphQL | Queries and mutations supported | Compiled document plus variables sent to one GraphQL endpoint | — |
| GraphQL subscriptions | Supported through a bounded observation window | The same compiled document, requested as `text/event-stream` | WebSocket (`graphql-ws`); the generated SDKs refuse this wire by design |
| SOAP 1.1 | Document/literal support is test-backed | XML envelope sent to the declared `soap:address` with `SOAPAction` | RPC/encoded and type-only messages |
| SOAP 1.2 | Implemented, not yet covered by the acceptance suite | SOAP 1.2 envelope and content type | RPC/encoded and type-only messages |
| gRPC with `google.api.http` | Supported, no declaration required | The verb, path, query, and body the annotation declares | Multi-segment path templates, nested field bindings, custom method kinds |
| gRPC without annotations | Supported only through a declared JSON transcoder | JSON sent to the service/method path | Native gRPC and streaming RPCs |
| Queue request/reply | Supported only through a declared facade — `@anvil/legacy-bridge`, conformance-tested against a double, never a live broker | JSON sent to the bridge's `POST /invoke`, which performs one queue request/reply exchange | Any transport other than a reviewed message binding with a `reply_to`/`fixed_destination` reply strategy |

Read [source format support](SOURCE_FORMATS.md) for parsing and source-graph
rules. Those rules are independent of this runtime matrix.

## How a binding reaches the runtime

Adapters preserve protocol facts on the operation's source binding.

- GraphQL stores the endpoint, compiled document, operation name, and root
  field. A subscription stores the same facts under its own protocol, plus a
  stream contract carrying its delivery guarantee and its bounds.
- SOAP stores the service endpoint, action, envelope namespace, body namespace,
  body element, response element, content type, and version.
- gRPC stores the service, method, and how the service is reached: `http_rule`
  when the proto declared its own route, `json_transcoded` when a transcoder can
  only be assumed.

The generated CLI, MCP server, runtime, and four client SDKs read those facts.
They do not reconstruct them independently.

## Request bodies

An operation's body is encoded by the content type AIR carries for it
(`input.body.contentType`), which the compiler takes from the source: JSON
when the source declares it, otherwise the first content type Anvil can
encode, otherwise the source's first declaration verbatim.

| Content type | On the wire |
| --- | --- |
| `application/json`, any `*+json` | `JSON.stringify` of the bound body, byte-for-byte as before |
| `application/x-www-form-urlencoded` | `URLSearchParams` semantics: scalars as `name=value`, an array as a repeated key. A nested object has no form representation and is refused |
| `multipart/form-data` | RFC 7578 multipart with a random boundary per request. A string, number, or boolean field is a text part; an object is a JSON part; a field whose schema is `type: string, format: binary` (or `format: byte`, or `contentEncoding: base64`) is a file part — the agent supplies base64, the wire gets the decoded bytes with `filename="<field>"` and the schema's `contentMediaType` (default `application/octet-stream`) |
| Anything else (`application/octet-stream`, `text/plain`, `application/xml` on a non-SOAP operation, …) | Refused |

A refusal is made twice, on the same fact. The compiler reports
`body_content_type_unsupported` and holds the operation `review_required`
unless a manifest already decided its state, and certification's transport
check fails for an approved operation that carries one. The runtime refuses
with `unsupported_operation` while the request is being built, which is
before any credential is resolved — an unencodable body never costs a secret
read. There is no facade for this: unlike a protocol, a body's content type is
not a coordinate an operator can point elsewhere.

A dry run shows a JSON body decoded, a form body as its encoded text, and a
multipart body as its size and content type — the boundary is random, so the
bytes themselves are not a plan.

The four generated SDKs encode JSON bodies only. A form or multipart body is
refused by their encoding gate with the same `unsupported_operation`, before a
delegated token is resolved, and the refusal points at the generated CLI and
MCP server, whose shared runtime does encode them. The SDK manifest carries
each operation's `bodyContentType`, and certification refuses a client whose
manifest disagrees with AIR about it.

## Parameter serialization

A path, query, header, or cookie parameter is serialized by the OpenAPI
`style` and `explode` the source declared, with OpenAPI's defaults filled in
when it did not: `form` (exploded) for query and cookie, `simple` for path and
header. AIR carries `style` and `explode` on a parameter only when the source
declared them, so a document from before the fields hashes exactly as before.

| Location, style | Array `["a","b"]` | Object `{x: 1, y: 2}` |
| --- | --- | --- |
| query `form`, explode (default) | `tag=a&tag=b` | `x=1&y=2` |
| query `form`, no explode | `tag=a,b` | `tag=x,1,y,2` |
| query `spaceDelimited` / `pipeDelimited` | `tag=a b` / `tag=a\|b` | refused |
| query `deepObject` | refused | `tag[x]=1&tag[y]=2` |
| path / header `simple` | `a,b` | `x,1,y,2`; exploded `x=1,y=2` |

A path item is percent-encoded and the commas between items are kept literal.
An object inside an object, an array of objects, and anything else no style
gives a meaning to is refused with `unsupported_operation` before the request
is built — never sent as `[object Object]`.

The one table lives in `@anvil/air` (`param-style.ts`). The runtime binds
through it, the hermetic harness derives its wire expectation from it (so the
oracle asks for what the contract promises rather than agreeing with whatever
was sent), and the four SDK cores restate it verbatim and are driven through
their real toolchains to prove the same query leaves every client.

## Binary responses

The transport decodes a response body as text only when its content type is
textual — `text/*`, JSON and `+json`, XML and `+xml`, JavaScript, forms, or
any type that declares a `charset`. Anything else (`application/pdf`,
`image/png`, `application/octet-stream`, …) is carried as base64, and the
HTTP/JSON codec returns a structured value instead of mangled text:

```json
{
  "contentType": "application/pdf",
  "encoding": "base64",
  "data": "JVBERi0xLjcK…",
  "bytes": 48213
}
```

The 8 MiB upstream byte cap applies to the bytes before encoding. The MCP
server puts a one-line description in the text content (`Binary response:
application/pdf (48213 bytes), …`) and the full value, bytes included, in
`structuredContent`. The generated CLI prints the same description on a
terminal and the full value under `--json`.

## GraphQL

Each GraphQL root field becomes one operation. Anvil compiles the request
document from the full SDL and stores that document with the operation.

```json
{
  "query": "query Anvil_Product($id: ID!) { product(id: $id) { id name priceCents } }",
  "variables": { "id": "prod_123" }
}
```

Caller values remain variables. They never enter the query text.

The agent-facing response schema is intentionally bounded. That limit does not
truncate the stored GraphQL document: the compiler derives the selection set
from the full SDL before it creates the bounded projection.

GraphQL can return an `errors` array with HTTP 200. Anvil treats that response
as a failure, including responses that contain both `data` and `errors`.

### Subscriptions

A subscription is compiled and executed, through a **bounded observation
window**. The call opens the stream, collects events until a bound is reached,
and returns them as an array.

The bound is not a limitation added on top. It is what makes a subscription a
call at all: everything in Anvil's safety core assumes one result to validate,
one execution record to write, and one outcome for retry and idempotency to
reason about. A stream with no end has none of those.

The request is the same document a query sends, with one header changed:

```http
POST /graphql
Accept: text/event-stream
```

Anvil reads `graphql-sse` — subscriptions over Server-Sent Events — and not
`graphql-ws`. That is deliberate rather than incidental: a WebSocket client is
something Python's and Go's standard libraries do not have, the same wall that
stops native gRPC, while SSE is chunked HTTP that every one of them can already
read. Choosing it keeps the door open for the generated clients.

Each operation carries a stream contract:

| Field | Meaning |
| --- | --- |
| `transport` | `graphql_sse` |
| `delivery` | `at_most_once` — Anvil reads a window and closes it; nothing is replayed and nothing resumes from a cursor |
| `maxEvents` | Stop after this many events (default 100) |
| `maxSeconds` | Stop after this long, whether or not anything arrived (default 30) |

Four things end a window: the event bound, the time bound, the server closing
the stream, or the subscription failing to start. An empty array is a real
answer — nothing was published while Anvil was listening — and is never
collapsed into `null`.

Neither bound is an agent input. A caller able to widen its own window could
hold a connection open indefinitely, which is the unbounded case wearing a
parameter. An Anvil manifest can resize either ceiling for an operation that
needs it (`stream: { max_events, max_seconds }`), up to AIR's absolute caps of
10,000 events and 300 seconds — the caps live on the schema itself, so nothing
can represent an unbounded window. A manifest can resize a window but never
create one.

Two rules keep a window honest. A frame Anvil did not see the end of is not
reported, even when its JSON happens to parse — the missing boundary is the
signal, not the parse. And keep-alive comments do not count as events, or an
idle service could exhaust a hundred-event window having published nothing.

An error in the **first** frame is a subscription that never started, and fails
the call. An error in a later frame is one bad event inside a window that
otherwise delivered; it is dropped and the window still returns, because failing
the whole call would discard good events the caller already waited for.

The four generated SDKs refuse this wire. They are request-and-response clients
and do not carry the bounded-read loop, so `graphql_sse` falls through their
transport gate and is refused by name. That is the surfaces agreeing the
operation is unreachable from a stateless client — not disagreeing about what it
means.

## SOAP

For a supported document/literal binding, Anvil sends an XML envelope to the
WSDL's declared service address.

```http
POST /soap
Content-Type: text/xml; charset=utf-8
SOAPAction: "http://example.com/banking/TransferFunds"
```

```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <n:TransferFundsRequest xmlns:n="http://example.com/banking">
      <n:amount>100</n:amount>
    </n:TransferFundsRequest>
  </soap:Body>
</soap:Envelope>
```

The runtime inspects the envelope before accepting the HTTP status. A
`soap:Fault` is a failure even when the server returns HTTP 200. A faulted
mutation is not recorded as complete in the idempotency ledger.

Anvil rejects DTD and entity declarations while reading XML. This blocks
external-entity expansion and entity-amplification payloads.

The current boundary is explicit:

- SOAP 1.1 document/literal behavior is covered by the runtime and SDK tests.
- SOAP 1.2 bindings are implemented but are not yet covered by the acceptance
  suite.
- RPC/encoded bindings and messages described only by `type` remain
  unavailable, with or without a protocol facade: the compiler declined to
  encode the call at all, so there is no request for a facade to receive.

## gRPC

Anvil does not implement native gRPC. Native gRPC requires HTTP/2, protobuf
framing, field-number fidelity, status trailers, and streaming behavior that
the generated cross-language clients do not share today.

There are two routes to a working gRPC service, and which one applies depends
on what the `.proto` file itself says.

### Methods that declare `google.api.http`

A method carrying the annotation states its own HTTP mapping:

```proto
rpc GetItem(GetItemRequest) returns (Item) {
  option (google.api.http) = { get: "/v1/items/{item_id}" };
}
```

This is the option grpc-gateway, Envoy's gRPC-JSON filter, and ESPv2 all read to
decide which route to serve. Anvil reads the same option and calls the same
route, so no declaration is required — the source document has already answered
the question. The operation is compiled to the declared verb and path, fields
bound in the template become path parameters, a named `body` field becomes the
JSON body, `body: "*"` sends the whole message minus the path-bound fields, and
everything else travels in the query string. On the wire there is nothing gRPC
about the call.

The declared verb also carries its ordinary HTTP semantics. A `get:` rule is a
retry-safe read; a `delete:` rule classifies as destructive. The method-name
heuristic that infers effect for an unannotated proto steps aside, because the
annotation is the better evidence, and the operation classifies exactly as the
OpenAPI document it has declared itself to be.

Four rule shapes are refused, each with the reason on the compile diagnostic:

- A path template binding a value that spans more than one path segment
  (`{parent=projects/*}`, `{name=books/**}`). Anvil percent-encodes a path
  parameter, so such a value would address a different resource rather than
  fail.
- A template binding a field inside a nested message (`{book.name}`). Path
  parameters bind by top-level field name.
- A `custom` method kind, which names a verb outside the set OpenAPI and the
  runtime share.
- A rule whose request message could not be resolved, so its bindings cannot be
  checked against it.

A refused rule does **not** fall back to gRPC's own path. A gateway serves the
declared route and no other, so that path is one the deployment provably does
not answer.

### Methods without annotations

A bare `.proto` cannot know whether a transcoder is deployed in front of it, so
the boundary must be declared. Examples include grpc-gateway and Envoy's
gRPC-JSON transcoder.

Without the declaration, execution stops before request construction. With the
declaration, Anvil sends JSON to the recorded service/method path and records
the reason on the execution result.

Streaming RPCs remain unavailable under either route. A stream cannot be
represented as one bounded request and response, and no gateway makes it one —
so an annotation on a streaming RPC is not read, and a declared facade does not
apply to it either.

`examples/grpc-gateway/` is an annotated service; `examples/grpc/` is a bare
one.

## Queue request/reply

`queue_request_reply` is different from every other row in the table above:
there is no native codec for it in `packages/runtime` at all, and there never
will be — a broker destination and a correlated reply is not HTTP shaped, the
same reason no facade can rescue a `graphql_sse` operation with no stream
contract. The binding always needs a declared facade, exactly like a gRPC
JSON transcoder.

The wire binding is a fact about a *reviewed legacy capability*, not a source
document's own declaration:

```json
{
  "protocol": "queue_request_reply",
  "legacyBindingContentHash": "sha256:…",
  "requestDestination": "PAY.REFUND.REQUEST",
  "reply": { "mode": "reply_to", "correlationField": "JMSCorrelationID" },
  "requestSchemaRef": "#/operation/inputSchema",
  "responseSchemaRef": "#/operation/outputSchema",
  "timeoutMs": 30000,
  "idempotency": { "carrier": "correlation_id" }
}
```

`legacyBindingContentHash` is the coherence property: it names the exact
`LegacyCapabilityBinding` (`packages/compiler/src/legacy/refinement/model.ts`)
this exchange executes, by content hash. `@anvil/legacy-bridge` refuses to
serve a wire binding whose hash does not match the binding it was handed —
structurally, not by convention — so a bridge can never silently answer for a
different, unreviewed, or since-changed candidate.

The facade that serves this wire (`@anvil/legacy-bridge`) is documented in
full in [Legacy runtime bridges](legacy-runtime-bridges.md#the-first-executable-bridge-queue-requestreply):
what it proves against a deterministic in-process broker double, what it does
not prove about a real broker, and its one protocol client (a zero-dependency
STOMP 1.2 client over `node:net`, chosen for the same reason `graphql-sse`
was chosen over `graphql-ws` above — the honest client a zero-dependency
implementation can actually deliver).

## Declaring a protocol facade

Use a protocol facade only when the deployed endpoint really accepts the
HTTP-shaped request generated by Anvil.

| Surface | Declaration |
| --- | --- |
| Generated CLI | `--protocol-facade "<reason>"` |
| Generated MCP or HTTP server | `ANVIL_PROTOCOL_FACADE=<reason>` |
| TypeScript SDK | `new Client({ protocolFacade: "<reason>" })` |
| Python SDK | `Client(protocol_facade="<reason>")` |
| Go SDK | `New(WithProtocolFacade("<reason>"))` |
| Java SDK | `builder().protocolFacade("<reason>")` |

The declaration records a deployment fact. It does not change AIR's source
provenance or claim that the upstream speaks another protocol.

A facade declares coordinates, not framing, and every refusal says which of
the two it is about. A **coordinates** refusal is one where Anvil knows exactly
what the call is and lacks only an address that serves it over HTTP+JSON — a
gRPC method whose transcoder is only assumed, a queue request/reply exchange
behind a bridge. A facade may answer it, and the call is recorded as
`protocol_facade_declared`. A **framing** refusal is one where the compiler
declined to encode the call at all: a streaming RPC, an rpc/encoded SOAP
binding or a message described only by type, a subscription with no bound, an
adopted MCP tool with no path or method. There is no request for a translator
to receive, so a facade does not apply and the call stays refused — the
runtime's gate and its codec resolution read the same verdict, so the gate can
never let through what the codec would then encode as JSON on a guess. The
refusal names its scope (`details.refusal_scope`) and its remedy, which for
framing is to fix the source the compile diagnostics name and recompile.

The subscription case is the clearest instance: a `graphql_sse` operation keeps
its `text/event-stream` request, its stream bound, and its array answer with or
without a facade declared. If a facade could re-route a subscription through
the JSON codec, the same operation would answer with one object under
`ANVIL_PROTOCOL_FACADE` and an array without it — two meanings for one
operation, selected by an environment variable. And a facade is not a way past
the bound: a subscription with no stream contract refuses even with one
declared, because no facade can make an unbounded window terminate.

## What refusal guarantees

When an operation has no executable binding:

1. The compiler reports `unexecutable_transport` (or, for a request body the
   runtime cannot encode, `body_content_type_unsupported`).
2. The runtime refuses before it builds a request, and in every case before it
   reads a credential.
3. Generated SDKs apply the same gates locally: the transport gate and the
   encoding gate for bodies and parameter values.
4. Certification fails if a callable surface claims a transport AIR cannot
   execute, or a body content type the runtime does not encode.

No generated surface can silently post JSON to an invented URL, JSON labelled
as another content type, or a parameter value serialized as `[object Object]`.

## What local assurance proves

`selftest`, `conformance`, and `simulate` run against generated local assets.
They prove that the bundle follows AIR. They do not prove that AIR matches a
live upstream.

Use `anvil observe` and `anvil conformance --live <config>` to compare the
reviewed contract with running behavior. Keep those checks within your normal
identity, network, and change-control boundaries.

Use `anvil sync <current-spec> <bundle>` for a different question: it compares
a caller-supplied current specification with stored AIR. It does not contact a
running application.
