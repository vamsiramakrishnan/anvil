# Source format support

“Supported” can mean four different things: Anvil can parse an input, capture
its local source graph, lower it into AIR, or execute the resulting operation.
These capabilities are listed separately below.

For example, Anvil can parse proto3 and generate aligned surfaces from any
`.proto` file. Whether it can also *execute* those operations depends on what
the file declares. A method carrying `google.api.http` names the HTTP route a
gateway serves, so Anvil calls that route directly and the operation is
wire-executable with nothing further to configure. A method with no annotation
leaves Anvil with only gRPC's own coordinate, which a native call would reach
over HTTP/2 with length-prefixed protobuf — so the bundle needs a declared JSON
transcoder before that operation becomes wire-executable.

Use this page to choose the right entrypoint and understand what must be
reviewed after compilation.

## Support matrix

| Source | Accepted input | Local source graph | Generated runtime | Declined or external behavior |
| --- | --- | --- | --- | --- |
| OpenAPI | OpenAPI 3.x YAML or JSON | Captures and resolves local `$ref` files | HTTP with JSON | Remote references are recorded but not fetched |
| Swagger | Swagger 2.0 YAML or JSON | Captures and resolves local `$ref` files | Converted to OpenAPI, then HTTP with JSON | Remote references are recorded but not fetched |
| GraphQL | GraphQL SDL (`.graphql`, `.gql`, `.graphqls`) | Composes every SDL file in the snapshot | Queries, mutations, and subscriptions as bounded windows | The generated SDKs refuse the subscription wire by design |
| gRPC | proto3 (`.proto`) | Captures transitive local imports | The route a `google.api.http` method declares; otherwise HTTP-shaped calls through a declared JSON transcoder | Native gRPC and streaming RPCs are refused |
| SOAP | WSDL 1.1 with embedded or local XSD | Captures `wsdl:import`, `xsd:include`, and `xsd:import` | Supported document/literal bindings | See the test-backed [wire protocol matrix](./wire-protocols.md) |
| Google APIs | Discovery `restDescription` JSON | One document | HTTP with JSON | Does not call Google discovery services |
| OData | v2 or v4 `$metadata` / EDMX XML | One metadata entrypoint | Entity sets; actions, functions, and v2 function imports; instance-bound operations through their entity set | Collection-bound and ambiguously-bound operations decline with a named reason; navigation semantics require review |
| Postman | Collection v2.0 or v2.1 JSON | One collection document | HTTP with JSON | Pre-request and test scripts are reported but never executed |

The format adapter is only the first stage. Every source then uses the same
normalize, classify, manifest, validate, capability, and generation pipeline.

## Detect the source before compiling

For a new input, use the discovery flow:

```bash
anvil agentify path/to/spec --out generated/service
```

`agentify` captures the source, compiles it, assesses operation readiness, and
proposes capability groupings. It stops for review.

For a source directory or multiple explicit entrypoints, capture first:

```bash
anvil source add path/to/spec-directory
anvil source list
anvil source show <snapshot-id>
anvil source validate <snapshot-id>
```

Then compile one locked entrypoint:

```bash
anvil compile --source <snapshot-id> \
  --entrypoint path/inside/snapshot \
  --out generated/service
```

The snapshot contains the exact local bytes Anvil read. Its id is content
derived. A broken or unclassified input may still be captured for diagnosis,
but only a valid snapshot can be compiled.

## Local and remote references

Source capture follows local references that belong to the supplied source
graph. It rejects path traversal and never follows a local reference outside
the import root.

Remote references are not fetched. This keeps compilation reproducible and
prevents a URL from changing the source after review. Vendor or remote schemas
must be vendored into the import root, or resolved upstream into a contract you
can snapshot.

For multi-entrypoint directories, pass the exact entrypoint when compiling a
snapshot. Do not rely on filename order.

## Format-specific notes

### OpenAPI and Swagger

OpenAPI is the richest source for HTTP semantics, but the document still may
not prove business effect or idempotency. Inspect POST operations carefully;
method alone is not a sufficient safety classification.

Swagger 2.0 is upgraded before normalization. It may span files exactly as
OpenAPI 3.x may: a 2.0 entrypoint's external `$ref`s are folded into the
document before conversion, because the 2.0 converter cannot follow them
itself. Only external references are folded in — an internal `#/definitions`
reference is left as written, so a self-referential definition stays a
reference rather than becoming a cycle. A reference to a file the snapshot does
not carry fails the compile rather than silently dropping the definition.

Review conversion diagnostics, especially around body/form parameters, security
definitions, and response schemas.

### GraphQL SDL

Anvil maps each root field to one operation:

- `Query` fields are reads;
- `Mutation` fields are mutations; and
- `Subscription` fields become bounded observation windows: the call collects
  events until an event or time bound and returns them as an array. See the
  [wire protocol matrix](./wire-protocols.md) for the contract and its bounds.

A subscription's window defaults to 100 events or 30 seconds, whichever comes
first. An operator can resize either ceiling in the manifest:

```yaml
operations:
  orderUpdated:
    stream:
      max_events: 500
      max_seconds: 120
```

The absolute caps — 10,000 events, 300 seconds — live on AIR's own schema, so
neither a manifest nor a hand-edited document can represent an unbounded
window. A manifest can resize a window but never create one: which operations
stream is a fact the compiler reads from the SDL, not a declaration.

Arguments become the request schema and return types become response schemas.
Custom scalars degrade to documented string values unless the source provides a
stronger mapping. SDL does not carry endpoint URL, resolver-side authorization,
or mutation idempotency; supply those operational facts separately.

A schema split across files compiles as one schema. SDL has no import
statement, so composition *is* concatenation: every SDL document in the snapshot
is composed, entrypoint first, and `extend type Query` blocks in sibling files
add their fields to the root type. Capture the directory to get them all:

```bash
anvil source add path/to/graphql-schema-directory
anvil compile --source <snapshot-id> --entrypoint schema.graphql --out generated/service
```

Pointing `anvil compile` at a single `.graphql` file compiles that file alone,
which is the right answer for a single-file schema and the wrong one for a
split schema whose root type would come out nearly empty.

### gRPC and proto3

Each RPC becomes an operation. Request and response messages become JSON
schemas; nested messages, enums, repeated fields, maps, `oneof`, and local
imports are parsed through `protobufjs`. Unresolved well-known types degrade
conservatively instead of stopping the whole compile.

A method carrying `google.api.http` is lowered to the verb and path it declares,
with path, query, and body bound as the rule says. A trailing custom method
(`/v1/items/{item_id}:adjust`, AIP-136) names the operation's action, so it does
not collide with the collection's plain `POST`. Such a method classifies exactly
as the equivalent OpenAPI operation, verb semantics included.

For a method with no annotation, names do not prove side effects. Read-like
prefixes such as `Get` and `List` can classify as reads; other RPCs remain
mutations until reviewed. The adapter preserves service and method identity, but
the generated HTTP-shaped request model is not itself a binary gRPC client.
Validate the runtime bridge or protocol adapter used in your deployment.

See the [wire protocol matrix](./wire-protocols.md) for which annotation shapes
are refused and why.

### SOAP and WSDL

Each WSDL `portType` operation becomes a POST-shaped operation. The adapter
understands the common document/literal XSD subset:

- global elements;
- `complexType` with `sequence` or `all`;
- `simpleType` enumeration restrictions;
- `complexContent` extension;
- element references;
- `minOccurs` and `maxOccurs`; and
- common XSD scalar types.

Operation names provide conservative effect hints; they do not prove
idempotency. See [Add the safety facts a WSDL leaves
out](https://vamsiramakrishnan.github.io/anvil/cookbooks/enrich-a-soap-service/)
for a complete example.

### Google Discovery

Discovery resources and methods map mechanically into paths and operations.
Request and response references become component schemas, and published OAuth
scopes are preserved. Operational authorization, quotas, and tenant policy
remain deployment concerns.

### OData metadata

Each entity set becomes list, read-one, create, update, and delete operations
where the metadata permits them. The adapter recognizes the structural subset
shared by OData v2 and v4 and honors supported SAP
`sap:creatable`, `sap:updatable`, and `sap:deletable` annotations.

An update body omits the entity's key properties. The key is how `PATCH
/Set('{key}')` addresses the entity, so carrying it in the body as well would
give a caller two places to put one identity.

Entity sets are only the nouns. A service's verbs — `ActivateProduct`,
`GetNearestAirport`, `ResetDataSource` — are compiled too, and OData states
their effect rather than leaving it to be guessed:

| Declaration | Lowers to | Effect |
| --- | --- | --- |
| v4 `Function` (via `FunctionImport`) | `GET /Name(arg='value')` | Read — v4 requires a function to be side-effect-free |
| v4 `Action` (via `ActionImport`) | `POST /Name` with a JSON body | Mutation |
| v2 `FunctionImport` with `m:HttpMethod="GET"` | `GET /Name?arg='value'` | Read |
| v2 `FunctionImport` with `m:HttpMethod="POST"` | `POST /Name?arg='value'` | Mutation |
| v2 `FunctionImport` with no `m:HttpMethod` | `POST /Name` | Mutation, with a diagnostic saying the document did not state it |

Parameter values carry OData's literal syntax — a quoted string, v2's
`datetime'…'` prefix, its `M`/`L` suffixes — compiled into the coordinate, so a
caller supplies the plain value and Anvil spells it correctly on the wire.

Bound actions and functions lower whenever their address can be constructed
without guessing. An operation bound to an entity instance is addressed through
the one entity set that exposes its binding type —
`POST /Airports('{IcaoCode}')/Trippin.Deactivate` — with the instance key as an
ordinary required path parameter (the same one the set's own read-by-key asks
for), a bound function's arguments inline in the coordinate, and a bound
action's arguments as the JSON body. Three shapes still decline, each with a
diagnostic naming its reason: an operation bound to a collection, a binding
type no entity set exposes, and a binding type exposed by more than one set —
either address would be a guess, and Anvil does not put guesses on the wire.
Navigation properties, deep inserts, and service-specific conventions may still
need an enriched or upstream-normalized contract.

### Postman collections

Folders become tags, saved requests become operations, and saved response/body
examples inform schemas. Secret-like auth values, header values, and query
values are not copied into the model.

Anvil does not execute pre-request or test scripts, and never will: collections
routinely embed live tokens, and a script is arbitrary JavaScript running
inside a compiler. The refusal is loud rather than silent. Every script-bearing
request is named in a `postman_script_untranslated` compile diagnostic —
pre-request scripts are very often the auth flow itself, so a collection could
otherwise compile into a surface that looks complete and cannot authenticate.
The diagnostic carries the remedy: declare the auth contract in an Anvil
manifest, then prove the result against the live service with
`anvil conformance`.

## Path grammar classification

Every source's paths carry meaning in one of two grammars: nouns (REST — the
HTTP method is the verb) or verbs (RPC-over-HTTP — the terminal path segment is
the method). The compiler used to know this only implicitly, by source kind,
which is how Plaid — an RPC grammar published as OpenAPI — had 72% of its
operations take a bare CRUD verb (`get`, `create`) as their resource. The
grammar is now classified explicitly, once per compile, from one deterministic
pass over the estate's operations (no network, no model), and declared in AIR
at `service.source.pathGrammar` with the classification, its basis, and the
counts that decided it — `anvil inspect` prints the verdict so a surprising
catalog name traces to an inspectable decision.

The taxonomy:

| Classification | Meaning | Example estate |
| --- | --- | --- |
| `resource_grammar` | Nouns in the path; HTTP methods carry the verb | Zendesk, GitHub, Stripe |
| `rpc_plain` | Verbs as plain terminal segments; method mix collapsed onto POST | Plaid (`POST /transactions/get`) |
| `rpc_dotted` | Dotted RPC method segments the URL itself declares | Slack (`/chat.postMessage`) |
| `adapter_lowered` | A protocol adapter (WSDL/GraphQL/protobuf/MCP) wrote the paths; the shape is declared by construction | NetSuite's lowered `/NetSuitePortType/get` |
| `ambiguous` | The evidence genuinely splits; the compiler declines to pick | — |

The evidence is three paired signals — the fraction of operations ending in a
CRUD-verb segment, the GET/HEAD share of the method mix, and the fraction of
paths carrying a `{param}` segment — each with an RPC pole, a REST pole, and a
deliberate abstention band between them, plus a dotted-terminal count that
short-circuits to `rpc_dotted` (Slack: 174 of 174) and a verb-repetition count
recorded for the operator. A grammar is picked only when at least two signals
commit to one side and none commit to the other. Measured on the untrimmed
estates the thresholds were calibrated against: Plaid classifies `rpc_plain`
(252/351 verb terminals, 5/351 GET, 4/351 parameterized), Zendesk/GitHub/
Stripe/BigQuery classify `resource_grammar`, Slack `rpc_dotted`.

What the classification drives: whether the naming pass receives the
estate-wide path context that arms the trailing-method re-homing rules
(`docs/design/resource-derivation-and-tool-name-stutter.md`). Resource and
plain-RPC grammars read a trailing CRUD verb as a method; dotted-RPC and
adapter-lowered grammars must not, because there the method name is the
operation's identity. An `ambiguous` estate emits a `path_grammar_ambiguous`
compile warning naming both candidate grammars and the counts for each, and
falls back to the source kind's pre-classifier reading, so declining to guess
never changes an estate's names. The warning names the remedy: a top-level
manifest declaration (`path_grammar: rpc_plain` — see
[MANIFEST.md](./MANIFEST.md#settle-the-estates-path-grammar)), which always
applies, and which records a `path_grammar_override_contradicts_evidence`
warning when it overrules a definite measured verdict.

## Declined, and why

Some gaps on this page are decisions, not roadmap. Filing a permanent no under
"not yet" reads as a promise, so each is stated with its reason.

- **Native gRPC.** A native call is length-prefixed protobuf over HTTP/2 with
  the status in trailers. Anvil's four generated SDKs are zero-dependency by
  contract, and Python's standard library has no HTTP/2 client — a native
  client would either break that contract or exist in some languages and not
  others, which is exactly the cross-surface divergence Anvil exists to
  prevent. Two paths work and stay: a `google.api.http` annotation, which
  Anvil reads with nothing further declared, and a JSON transcoder
  (grpc-gateway, Envoy's gRPC-JSON filter) declared as a protocol facade.
- **GraphQL subscriptions over WebSocket (`graphql-ws`).** The same wall:
  Python's and Go's standard libraries have no WebSocket client.
  Subscriptions are served over `graphql-sse` — chunked HTTP, which every
  runtime already reads. A service that speaks only `graphql-ws` needs an
  SSE-speaking gateway in front of it; that is a real cost, stated rather
  than hidden.
- **Postman script execution.** Collections routinely embed live tokens, and
  a script is arbitrary JavaScript running inside a compiler. The scripts'
  presence is surfaced per request (see above); the modeled fix is a
  manifest, never execution.
- **Fetching remote `$ref`s at compile time.** Compilation reads only the
  content-addressed snapshot, so a compile is reproducible and a URL cannot
  change a contract after review. Vendor remote schemas into the import root
  and snapshot them.

## Gateways are a different entrypoint

An API gateway export is not automatically an API contract. Gateway artifacts
may add routing, auth, policy, deployment revision, and ownership evidence that
must remain attached to the imported API.

Run:

```bash
anvil estate support --json
```

before preparing an export, then follow [Gateway estates](gateways.md). Support
varies by vendor and input tier; do not assume Anvil connects to a live gateway
or understands every native bundle.

## After compilation

For every format:

```bash
anvil status generated/service
anvil inspect generated/service
anvil assess generated/service
anvil lint generated/service
```

Treat adapter output as a candidate contract. Resolve missing business meaning
in an [Anvil manifest](MANIFEST.md), recompile, and approve only the operations
you have inspected.
