# Wire protocols: what Anvil can actually call

Anvil accepts eight source formats. It speaks two wire protocols: **HTTP with a
JSON body**, and **SOAP** (1.1 and 1.2, document/literal). GraphQL and gRPC it
refuses, loudly, rather than pretending.

Those facts were once not written down together, and the gap between them was
invisible. This page is that gap, stated — and closed, for SOAP.

## What was wrong

`SourceRef.kind` records where an operation came from — `openapi`, `wsdl`,
`graphql`, `protobuf`. It is a *document format*. It was never a statement about
what a call must look like on the wire, and Anvil treated it as one.

Every non-REST adapter lowers its source into an OpenAPI-shaped intermediate
document. OpenAPI keys operations by path, so an adapter for a protocol that has
no per-operation path has to invent one:

| Source | Synthesized coordinate | What a real call is |
| --- | --- | --- |
| WSDL | `POST /BankingPort/TransferFunds` | An XML envelope posted to the single `<soap:address>` endpoint, dispatched by a `SOAPAction` header — **now what Anvil sends** |
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

## SOAP works

The WSDL adapter now reads what it used to discard — the `<soap:address>`
endpoint, the `soapAction`, the SOAP version, and the namespace-qualified QName
of the body element — and records them on `sourceRef.binding`. A codec in the
runtime turns that into an envelope, and each of the four SDKs carries the same
codec in its own decision core.

```xml
POST /soap
Content-Type: text/xml; charset=utf-8
SOAPAction: "http://example.com/banking/TransferFunds"

<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <n:TransferFundsRequest xmlns:n="http://example.com/banking">
      <n:amount>100</n:amount>
    </n:TransferFundsRequest>
  </soap:Body>
</soap:Envelope>
```

Five surfaces, those exact bytes, asserted byte-for-byte across four real
toolchains in `packages/generators/src/sdk-soap.test.ts`.

**Faults are failures.** A `soap:Fault` arrives inside a successful envelope, and
servers send one with HTTP 200 as readily as 500 — so the status is not the
answer. Anvil reads the envelope first, refuses the call, and never records a
faulted mutation in the idempotency ledger as completed. Only a `Server` fault
is transient (`soap_transport_fault`, the retry condition AIR has declared since
the beginning and nothing could previously emit); a `Client` fault will fail
identically on retry, so retrying one is refused.

**What is still declined.** Only `document`/`literal` bindings whose messages are
described by `element`. An `rpc` or `encoded` binding, or a message described by
`type`, records no binding and stays refused with a compile diagnostic naming
which. That is the posture, not a gap to be embarrassed about: rpc wraps the
parts in an operation-named element and encoded carries per-element type
attributes, and encoding either on a guess is how you corrupt a legacy system
politely.

**Reading XML safely.** Anvil parses SOAP responses with a reader that refuses
`<!DOCTYPE` and `<!ENTITY` outright — in the runtime, in the TypeScript client
(Node has no XML parser in its standard library, and the generated SDKs are
zero-dependency by contract), and via `disallow-doctype-decl` on Java's factory.
External-entity expansion (XXE) and the billion-laughs denial of service both
require a DTD, so neither is defended against: both are unparseable.

## What the refusal looks like when it applies

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
$ anvil certify out/storefront
  safety    FAIL  (7/8 checks)
    ✗ safety.protocol-runtime-executable: 9 approved operation(s) speak graphql,
      which this runtime cannot put on the wire — a GraphQL call posts
      {query, variables} to the one GraphQL endpoint; the field name travels in
      the document body, never in the URL. …
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
- **The GraphQL and gRPC examples are uncertifiable**, deliberately, until
  either a facade is declared or Anvil grows their codecs. They still compile,
  inspect, lint, approve, and self-test. `examples/soap` certifies.

## What the remaining two would need

SOAP is done. The other two need the model to carry what their encoding needs,
and today it does not:

- **GraphQL** needs a selection set, which AIR cannot hold: `output.schema` is
  depth-truncated to keep schemas bounded.
- **gRPC** needs protobuf field numbers, which the adapter never reads, plus
  framing and trailers. Its path is already real, so a declared JSON-transcoder
  facade is the cheapest honest first cut.

Each of those is a modelling decision, not a coding task, which is why none of
them is in this change.
