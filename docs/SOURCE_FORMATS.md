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
| Swagger | Swagger 2.0 YAML or JSON | Single file only; bundle external references first | Converted to OpenAPI, then HTTP with JSON | Multi-file Swagger 2.0 is rejected |
| GraphQL | GraphQL SDL (`.graphql`, `.gql`, `.graphqls`) | One SDL entrypoint | Queries and mutations | Subscriptions are represented but refused |
| gRPC | proto3 (`.proto`) | Captures transitive local imports | The route a `google.api.http` method declares; otherwise HTTP-shaped calls through a declared JSON transcoder | Native gRPC and streaming RPCs are refused |
| SOAP | WSDL 1.1 with embedded or local XSD | Captures `wsdl:import`, `xsd:include`, and `xsd:import` | Supported document/literal bindings | See the test-backed [wire protocol matrix](./wire-protocols.md) |
| Google APIs | Discovery `restDescription` JSON | One document | HTTP with JSON | Does not call Google discovery services |
| OData | v2 or v4 `$metadata` / EDMX XML | One metadata entrypoint | HTTP with JSON for generated entity-set operations | Actions, functions, and navigation semantics require review |
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

Swagger 2.0 is upgraded before normalization. It must be supplied as one
bundled document; multi-file Swagger 2.0 is rejected. Review conversion
diagnostics, especially around body/form parameters, security definitions, and
response schemas.

### GraphQL SDL

Anvil maps each root field to one operation:

- `Query` fields are reads;
- `Mutation` fields are mutations; and
- `Subscription` fields are represented as read-like operations with streaming
  noted in their description.

Arguments become the request schema and return types become response schemas.
Custom scalars degrade to documented string values unless the source provides a
stronger mapping. SDL does not carry endpoint URL, resolver-side authorization,
or mutation idempotency; supply those operational facts separately.

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

Navigation properties, actions, functions, deep inserts, and service-specific
conventions may need an enriched or upstream-normalized contract.

### Postman collections

Folders become tags, saved requests become operations, and saved response/body
examples inform schemas. Secret-like auth values, header values, and query
values are not copied into the model.

Anvil does not execute pre-request or test scripts because those scripts can
contain auth flows, stateful chaining, and arbitrary code. The adapter reports
their presence so the omission is visible.

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
