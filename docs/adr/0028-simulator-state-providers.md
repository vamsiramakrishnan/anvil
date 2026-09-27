# ADR-0028: The simulator's state can come from a provider

**Status:** Accepted

## Context

The simulator (ADR-0017) serves a contract's surface faithfully: auth scopes,
confirmation, required idempotency and replay, pagination, seeded faults, and
response bodies shaped by the declared schema. Its state is a seeded fixture
store: a few records per resource with an id and a status. It loads no
external data and evaluates no query, so a filter parameter changes nothing
and a get of an unknown id returns the first fixture.

That is enough to certify a surface and to measure response cost. It is not
enough to evaluate an agent on a task whose answer depends on data: a fixture
database, a recorded session to replay, or a generated corpus. Those systems
already own their records and their query semantics. What they lack is the
surface, and rebuilding auth, idempotency, paging, and error mapping per data
source would drift from the contract the same way a hand-written mock does.

The simulator was also reachable only in process, by MCP tool name. A
generated SDK and the generated MCP server both reach an API over HTTP, at the
contract's paths, so neither could target it.

## Decision

1. **A `StateProvider` seam in `@anvil/simulator`.** After every surface gate
   passes (tool exists, scopes, confirmation, required key, replay, fault,
   required inputs), the simulator hands the call to the provider as one
   normalized request: operation id and tool name, a coarse `kind`
   (`read`, `list`, `search`, `create`, `update`, `delete`, `action`) derived
   from AIR's effect classification, parameters by wire name and location,
   the body, the page (`cursor`, `size`) for paged operations, the principal,
   the tenant, the idempotency key, and a request id that is a function of
   the call sequence. The provider answers with a result, a page of items
   and a continuation, or a typed domain error. Anvil maps the error onto the
   operation's declared errors (status and vendor code) and wraps pages in the
   contract's envelope.

2. **The built-in store is the default.** Without a provider, `invoke`
   behaves exactly as before, and `invokeAsync` returns the same results. A
   provider may answer asynchronously, so a provider-backed simulator serves
   through `invokeAsync` and `call`, and the synchronous `invoke` refuses
   rather than silently serving fixtures.

3. **An out-of-process provider over stdio JSON-RPC 2.0.** One message per
   line; `initialize` carries the contract digest, the surface digest, the
   seed, and the served operations; `invoke` carries the normalized request;
   `shutdown` stops the child. Requests have deadlines, and a dead child fails
   every pending and later call with its exit status and stderr tail. The
   protocol is specified in `docs/simulator-state-providers.md` so a provider
   can be written in any language.

4. **HTTP serving.** `anvil simulate serve --contract <bundle>` serves each
   approved operation where the runtime's codec for its protocol sends it
   (its declared path and method; for GraphQL, one endpoint with the
   operation in the document) and prints the bound URL. A body is decoded in
   the content type the operation declares. An operation the server cannot
   reach over its native protocol is refused at startup, not served as 404;
   `--protocol-facade` serves SOAP and other coordinate-only protocols at
   their synthesized paths for clients that declare a facade. Principal, tenant, and fault scenario come from headers; the
   idempotency key comes from the contract's carrier. Confirmation is treated
   as given, because every calling surface enforces it before sending and the
   wire has no field for it.

5. **A call trace.** Each call can append one JSON line: the request as the
   agent sent it, the normalized request, the provider's answer, the result,
   and the final status and body. No clock is recorded. The trace file is
   opened before serving; a later write failure is reported and never changes
   the response of a call that already happened.

## Consequences

- Any system that can answer the normalized request can serve an agent
  through Anvil's surface, and read back what the agent did from the trace.
  Anvil does not learn anything about the system behind the provider.
- The provider path adds a required-input check (required parameters and
  body) the built-in store never had. The built-in store is unchanged, so
  certification and disclosure measurements do not move.
- A provider that returns more items than `page.size` is refused with
  `schema_mismatch` instead of being trimmed, since trimming would lose
  records no cursor can reach.
- Replay stays a surface guarantee: a repeated key, including a concurrent
  one, is answered by Anvil without a second provider call.
- `disclosureSample` and the certification passes continue to use the
  built-in store. Measuring response cost against a provider's data is a
  separate decision.
- HTTP serving does not issue OAuth tokens. A contract with client-credentials
  auth still needs a reachable token endpoint when driven through the MCP
  runtime; the generated SDK can pass a static token.
