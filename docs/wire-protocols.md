# Wire protocols: what Anvil can actually call

Anvil accepts eight source formats. It can put exactly one wire protocol on the
wire: **HTTP with a JSON body**.

Those two facts were never written down together, and the gap between them was
invisible. This page is that gap, stated.

## What was wrong

`SourceRef.kind` records where an operation came from — `openapi`, `wsdl`,
`graphql`, `protobuf`. It is a *document format*. It was never a statement about
what a call must look like on the wire, and Anvil treated it as one.

Every non-REST adapter lowers its source into an OpenAPI-shaped intermediate
document. OpenAPI keys operations by path, so an adapter for a protocol that has
no per-operation path has to invent one:

| Source | Synthesized coordinate | What a real call is |
| --- | --- | --- |
| WSDL | `POST /BankingPort/TransferFunds` | An XML envelope posted to the single `<soap:address>` endpoint, dispatched by a `SOAPAction` header |
| GraphQL | `POST /graphql/Mutation/checkout` | `{query, variables}` posted to the one GraphQL endpoint; the field name is in the body, never the URL |
| protobuf | `POST /acme.orders.v1.OrderService/GetOrder` | The path is real — it is gRPC's `:path` — but the body is length-prefixed protobuf over HTTP/2, with `grpc-status` in trailers |
| MCP (adopted) | *no path, no method* | A `tools/call` over the MCP transport |

Those coordinates are legitimate *internal* keys — they hold operations apart in
a path-keyed model. They are not addresses. Nothing recorded the difference, so
the runtime read them as addresses and posted JSON at them.

Then the assurance stack agreed, because it was self-consistent rather than
reality-anchored. `anvil selftest`, `anvil conformance`, and `anvil simulate`
all drive the bundle against a mock **generated from the same AIR** — the mock
serves `/BankingPort/TransferFunds` and accepts JSON, because it was built from
the same `sourceRef` the client sends to. A SOAP bundle whose `service.servers`
was empty, and which could not have addressed the service at all, certified with
**38 of 38 checks passing and zero failures**.

## What Anvil does now

`@anvil/air` models the wire protocol as a fact of its own, derived from the
source kind in exactly one place. Four surfaces read it:

- **The compiler** emits `unexecutable_transport` at compile time, so the fact
  is not first heard at deploy.
- **The runtime** refuses at step 0b of the execution gauntlet — before the
  request is built. The CLI, the MCP server, and all four SDKs share this
  executor, so none can route around it.
- **The generated SDKs** each carry the same gate in their own decision core,
  because they do not go through the executor. Certification compares each
  client's declared protocol against AIR.
- **Both certification engines** refuse the bundle, reading the one definition
  rather than restating it, so they cannot reach opposite verdicts.

```
$ anvil certify out/banking
  safety    FAIL  (7/8 checks)
    ✗ safety.protocol-runtime-executable: 4 approved operation(s) speak soap,
      which this runtime cannot put on the wire — a SOAP call is an XML envelope
      posted to the single endpoint named by <soap:address>, dispatched by a
      SOAPAction header — not JSON posted to a per-operation path. …
```

This makes no call work that did not work before. It converts a green lie into a
loud refusal, which is the only honest first move: the alternative — extracting
the real endpoint and sending JSON to it — would replace a bundle that fails
fast with one that reaches a production SOAP service and is misunderstood.

## The one way past, and why it is a declaration

There is a legitimate deployment this would otherwise block. A REST-to-SOAP or
REST-to-GraphQL gateway facade really can serve the synthesized coordinates over
HTTP+JSON. Anvil's own generated mock is exactly such a facade — which is why
the hermetic lanes passed a bundle that could never make a real call.

So the gate is opened by *saying so*, never by inference:

| Surface | How |
| --- | --- |
| Generated CLI | `--protocol-facade "<reason>"` |
| Generated MCP server / HTTP server | `ANVIL_PROTOCOL_FACADE=<reason>` |
| TypeScript SDK | `new Client({ protocolFacade: "<reason>" })` |
| Python SDK | `Client(protocol_facade="<reason>")` |
| Go SDK | `New(WithProtocolFacade("<reason>"))` |
| Java SDK | `builder().protocolFacade("<reason>")` |

The reason is recorded on the execution record as a policy decision. A silent
escape hatch would be worse than no gate: it would move the same untrue
assumption somewhere nobody can see it afterwards.

`anvil selftest` and `anvil conformance` now set it explicitly, with the reason
*"Anvil's generated mock, built from the same AIR coordinates the bundle sends
to."* That is not a workaround; it is those lanes stating the assumption they
had always silently made.

## What still is not fixed

- **The hermetic lanes remain self-referential.** They prove the bundle is
  faithful to AIR, which is worth proving, and cannot prove AIR is faithful to
  the running system. Only `anvil observe`, `anvil live`, and `anvil sync`
  anchor outside AIR.
- **A REST bundle can still be wrong.** Nothing here checks that an OpenAPI
  path is served or that its schema matches reality. It refuses only protocols
  the runtime provably cannot speak.
- **The three non-REST examples are now uncertifiable**, deliberately, until
  either a facade is declared or Anvil grows real codecs. They still compile,
  inspect, lint, approve, and self-test.

## What real support would need

Refusing is step one. Executing needs the model to carry what the encoding
needs, and today it does not:

- **SOAP** needs a constant header (AIR's `Param` has no fixed-value field, and
  the only constant-header path in the runtime is the audited auth merge), an
  envelope wrapper (`RequestBody.projection` is only `fields | whole`), and XML
  namespaces — which the WSDL adapter drops *by explicit design*, because its
  multi-file XSD merge depends on being namespace-blind. Collapsing four
  operations onto the single real `/soap` path also breaks the path-keyed map.
- **GraphQL** needs a selection set, which AIR cannot hold: `output.schema` is
  depth-truncated to keep schemas bounded.
- **gRPC** needs protobuf field numbers, which the adapter never reads, plus
  framing and trailers. Its path is already real, so a declared JSON-transcoder
  facade is the cheapest honest first cut.

Each of those is a modelling decision, not a coding task, which is why none of
them is in this change.
