# Source format support

Anvil accepts several API description formats, but “supported” has a precise
meaning: Anvil can detect the input, capture its local source graph, lower it
into the canonical model, and generate the aligned bundle. It does not imply
that every vendor extension, script, policy, or native wire transport is
executed. Anvil speaks three wire protocols — HTTP with a JSON body, SOAP (1.1
and 1.2, document/literal), and GraphQL (queries and mutations) — and [refuses,
loudly, to pretend otherwise](./wire-protocols.md) for the rest. Compiling a
`.proto` gives you a reviewed model and aligned surfaces, and a bundle that will
not be certified for deployment until a facade that really does serve it is
declared.

Use this page to choose the right entrypoint and understand what must be
reviewed after compilation.

## Support matrix

| Source | Accepted input | Multi-file behavior | Important boundary |
| --- | --- | --- | --- |
| OpenAPI | OpenAPI 3.x YAML or JSON | Local `$ref` files are captured and dereferenced | Remote references are recorded as external and are not fetched during source capture |
| Swagger | Swagger 2.0 YAML or JSON | Same local-reference behavior as OpenAPI | Converted to OpenAPI with `swagger2openapi` before the shared pipeline |
| GraphQL | GraphQL SDL (`.graphql`, `.gql`, `.graphqls`) | One SDL entrypoint | Queries become reads; mutations remain conservative mutations; **Executable**: queries and mutations post a document compiled from the SDL; subscriptions are represented and refused, since Anvil has no streaming client — see [Wire protocols](./wire-protocols.md) |
| gRPC | proto3 (`.proto`) | Transitive local imports are captured and loaded into one protobuf root | RPCs are lowered to an HTTP-shaped contract on gRPC's own real path. **Executable through a declared JSON transcoder** (grpc-gateway, Envoy); native gRPC is not, since Python's standard library has no HTTP/2 client. Streaming RPCs are refused — see [Wire protocols](./wire-protocols.md) |
| SOAP | WSDL 1.1 with embedded or local XSD | `wsdl:import`, `xsd:include`, and `xsd:import` are captured locally | Supports the documented/literal XSD subset described below. **Executable**: Anvil posts a real envelope to the declared `<soap:address>`; `rpc`/`encoded` bindings are refused rather than guessed — see [Wire protocols](./wire-protocols.md) |
| Google APIs | Discovery `restDescription` JSON | Single Discovery document | Mechanically maps resources, methods, schemas, parameters, and OAuth scopes; it does not call Google discovery services |
| OData | v2 or v4 `$metadata` / EDMX XML | One metadata entrypoint | Generates conventional entity-set CRUD operations and honors supported SAP mutability annotations; actions/functions and navigation semantics require review |
| Postman | Collection v2.0 or v2.1 JSON | One collection document | Saved examples inform schemas; pre-request and test scripts are counted and reported, never executed |

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

Swagger 2.0 is upgraded before normalization. Review conversion diagnostics,
especially around body/form parameters, security definitions, and response
schemas.

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

gRPC method names do not prove side effects. Read-like prefixes such as `Get`
and `List` can classify as reads; other RPCs remain mutations until reviewed.
The adapter preserves service and method identity, but the generated
HTTP-shaped request model is not itself a binary gRPC client. Validate the
runtime bridge or protocol adapter used in your deployment.

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
idempotency. See [Add the safety facts a WSDL leaves out](../apps/docs/src/content/docs/cookbooks/enrich-a-soap-service.md)
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
