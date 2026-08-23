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
| HTTP with JSON | Supported | Method, URL, headers, query, and JSON body from AIR | Unsupported content types remain unavailable |
| GraphQL | Queries and mutations supported | Compiled document plus variables sent to one GraphQL endpoint | Subscriptions |
| SOAP 1.1 | Document/literal support is test-backed | XML envelope sent to the declared `soap:address` with `SOAPAction` | RPC/encoded and type-only messages |
| SOAP 1.2 | Implemented, not yet covered by the acceptance suite | SOAP 1.2 envelope and content type | RPC/encoded and type-only messages |
| gRPC with `google.api.http` | Supported, no declaration required | The verb, path, query, and body the annotation declares | Multi-segment path templates, nested field bindings, custom method kinds |
| gRPC without annotations | Supported only through a declared JSON transcoder | JSON sent to the service/method path | Native gRPC and streaming RPCs |

Read [source format support](SOURCE_FORMATS.md) for parsing and source-graph
rules. Those rules are independent of this runtime matrix.

## How a binding reaches the runtime

Adapters preserve protocol facts on the operation's source binding.

- GraphQL stores the endpoint, compiled document, operation name, and root
  field.
- SOAP stores the service endpoint, action, envelope namespace, body namespace,
  body element, response element, content type, and version.
- gRPC stores the service, method, and how the service is reached: `http_rule`
  when the proto declared its own route, `json_transcoded` when a transcoder can
  only be assumed.

The generated CLI, MCP server, runtime, and four client SDKs read those facts.
They do not reconstruct them independently.

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

Subscriptions are refused because the generated clients implement bounded
request-response calls, not streams.

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
  unavailable.

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
so an annotation on a streaming RPC is not read.

`examples/grpc-gateway/` is an annotated service; `examples/grpc/` is a bare
one.

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

## What refusal guarantees

When an operation has no executable binding:

1. The compiler reports `unexecutable_transport`.
2. The runtime refuses before it builds a request.
3. Generated SDKs apply the same gate locally.
4. Certification fails if a callable surface claims a transport AIR cannot
   execute.

No generated surface can silently post JSON to an invented URL.

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
