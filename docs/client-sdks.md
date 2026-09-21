# Client SDKs

Anvil generates TypeScript, Python, Go, and Java clients from the same AIR
contract as the CLI and MCP server. Use a generated SDK when an application
needs those operations and policy checks without a terminal or MCP client.

Regenerate clients after changing the source or manifest. Shared input enables
consistent policy; generation and conformance tests provide the evidence that
each surface enforces it. Hand-edited generated clients are outside that claim.

## Generate and inspect the clients

`anvil compile` writes all four clients under `sdk/` in the bundle.

```text
sdk/
  manifest.json
  README.md
  typescript/
  python/
  go/
  java/
```

Inspect the generated method set before copying a client:

```bash
pnpm anvil sdk generated/payments
pnpm anvil sdk generated/payments --json
```

Emit only the languages you need:

```bash
pnpm anvil sdk generated/payments \
  --lang typescript,python \
  --out clients/payments
```

The command writes `typescript/`, `python/`, `manifest.json`, and `README.md`
under `clients/payments`.

## Build a generated client

Each language directory is independently vendorable. Runtime code uses only
the language's standard platform libraries.

The commands below assume you are at the generated bundle root. If you used
`--out clients/payments`, replace `sdk/` with `clients/payments/`.

| Language | Requirement | Build or install |
| --- | --- | --- |
| TypeScript | Node.js 20+ and TypeScript | `cd sdk/typescript && npm install && npm run build` |
| Python | Python 3.9+ | `python3 -m pip install ./sdk/python` |
| Go | Go 1.21+ | `cd sdk/go && go build ./...` |
| Java | Java 11+ and Maven | `cd sdk/java && mvn package` |

Each directory contains a language-specific README with the generated package
name, client class, credential variable, and first call.

## Authentication

A service's auth scheme is a service-level fact (`sdk/manifest.json`'s `auth`
block), resolved from the first approved operation that declares one. All
four clients read the *same* environment-variable NAMES for it — the SDK
convention is `<SERVICE>_*` where the runtime's own resolver
(`packages/runtime/src/auth.ts`) uses `ANVIL_<PROFILE>_*`; only the prefix
differs, the suffixes match exactly, and neither ever carries the value
itself into a bundle, a log, or an error.

| Scheme | What travels on the wire | Env vars an SDK reads | Notes |
| --- | --- | --- | --- |
| `api_key`, `basic`, … (static bearer/API key) | A resolved token or key, in the carrier AIR declared (default `Authorization: Bearer` or `X-API-Key`) | `<SERVICE>_TOKEN` (or `_API_KEY`) | Unchanged by this page — the baseline every other scheme is described relative to. |
| `oauth2_client_credentials` | A bearer the SDK mints itself with the client-credentials grant (RFC 6749 §4.4), or a pre-minted one | `<SERVICE>_TOKEN` to replay a token you already hold; otherwise `<SERVICE>_CLIENT_ID` / `_CLIENT_SECRET` to mint, only when the contract names a token endpoint | See "Minting a client-credentials token" below. Without a declared token endpoint the SDK keeps reading `<SERVICE>_TOKEN`, exactly as before. |
| `oauth2_on_behalf_of` | A bearer exchanged from the inbound caller's subject token (RFC 8693) | `<SERVICE>_CLIENT_ID` / `_CLIENT_SECRET` (the SDK's own client), `<SERVICE>_ACTOR_TOKEN` when the contract's delegation names an actor; the subject token is never an env var | See "On-behalf-of (token exchange)" below. `<SERVICE>_TOKEN` still replays a token you already hold. |
| `custom_header` | The raw value, under the exact header (or query parameter) name AIR declared — **never** a `Bearer`/`Basic` scheme prefix | `<SERVICE>_HEADER_VALUE` | Same carrier plumbing as a bearer token; the only difference is the carrier scheme is empty. |
| `mtls` | Nothing in a header — the client certificate is presented on the TLS handshake itself | Whatever names `auth.tls.clientCertRef` / `clientKeyRef` / `caRef` carry — there is no fixed `<SERVICE>_*` suffix for this scheme, because the names are the exact ones the manifest or compiler declared (e.g. `PAYMENTS_MTLS_CLIENT_CERT`), the same ones the runtime resolves for the same operation | A value is read as literal PEM text when it starts with `-----BEGIN`, otherwise as a file path. `caRef` is optional; when absent, the platform's default trust store is used instead of a private CA. |
| `oauth2_authorization_code` | A bearer token, replayed or refreshed — the interactive PKCE step never runs inside a generated SDK | `<SERVICE>_TOKEN` to replay a token you already have; `<SERVICE>_REFRESH_TOKEN` / `_CLIENT_ID` / `_CLIENT_SECRET` for the optional refresh helper, only emitted when the contract names a token endpoint | See "Delegated tokens" below. |

### Custom-header carriers

The carrier is exactly what AIR declared — no assumption about `Bearer`,
`Basic`, or any other scheme:

```ts
const client = new PaymentsClient({ token: process.env.PAYMENTS_HEADER_VALUE });
// sends `X-Api-Auth: <value>` (or whatever header/query name AIR declared) —
// never `Authorization: Bearer <value>`
```

### Mutual TLS

Every language uses only its platform's standard TLS facilities — no new
dependency in any of the four:

| Language | Mechanism |
| --- | --- |
| TypeScript | `node:https` (a `FetchLike` presenting a client certificate; the platform `fetch` has no injectable dispatcher, so this is the one scheme that does not use it) |
| Python | `ssl.SSLContext.load_cert_chain` behind a `urllib` opener (PEM read from the env, or a file path; a literal PEM value is written once to a private, mode-`0600` temp file, because `load_cert_chain` only accepts file paths) |
| Go | `tls.Config{Certificates: […]}` from `tls.X509KeyPair`, `RootCAs` from the declared CA — an `*http.Client` a caller can also build and inject with `WithHTTPClient` |
| Java | An `SSLContext` built from PEM using only `java.security` / `javax.net.ssl` — **the private key must be PKCS#8** (`-----BEGIN PRIVATE KEY-----`); convert a traditional PKCS#1 RSA key first: `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem` |

```go
client, err := payments.New() // reads PAYMENTS_MTLS_CLIENT_CERT / _CLIENT_KEY / _CA
```

An explicit transport always wins over the environment: `{ tls: {...} }` in
TypeScript, `opener=` in Python, `WithHTTPClient(...)` in Go,
`.httpClient(...)` in Java.

### Delegated tokens (`oauth2_authorization_code`)

Every language accepts a token you already hold, or a provider that resolves
one per call — the delegated-token contract:

| Language | Static token | Token provider |
| --- | --- | --- |
| TypeScript | `{ token }` | `{ tokenProvider: () => Promise<string> }` |
| Python | `token=` | `token_provider=` (a zero-argument callable) |
| Go | `WithToken(...)` | `WithTokenProvider(func(context.Context) (string, error))` |
| Java | `.token(...)` | `.tokenSupplier(Supplier<String>)` |

A caller-supplied token or provider always wins. When neither is set and the
contract names a token endpoint, each SDK exposes a `createRefreshingTokenProvider`
(TypeScript/Python name; `NewRefreshingTokenProvider` in Go,
`Oauth.refreshingTokenProvider` in Java) that exchanges
`<SERVICE>_REFRESH_TOKEN` + `<SERVICE>_CLIENT_ID` (+ optional `_CLIENT_SECRET`)
at the declared token endpoint (RFC 6749 §6) and caches the access token in
memory until shortly before it expires — and the client wires one in
automatically when those env vars are present.

That refresh authenticates to the token endpoint the way the contract declares
and the runtime already does (`provider.clientAuth`, RFC 6749 §2.3.1), not the
way each language finds convenient:

| Declared method | What every SDK sends |
| --- | --- |
| `client_secret_basic` (the default when the contract names none) | HTTP Basic, and **no** `client_id` in the form |
| `client_secret_post` | `client_id` and `client_secret` in the form, and **no** Basic header |
| `private_key_jwt` | Nothing — refused. No refresh helper mints an RFC 7523 assertion, so a contract that declares it is refused as incoherent before it can be approved, the runtime fails closed, and the generated helper raises rather than substituting a client secret the caller may not even have. (The runtime's client-credentials and token-exchange grants **do** implement the method; the generated SDKs' helpers for those grants refuse it the same way this one does.) |

An identity provider registered for one method rejects the other, so this is
not cosmetic: it is the same agreement the CLI and the MCP server make about
the same operation. `packages/generators/src/sdk-oauth-refresh.test.ts` drives
each language's real helper against a local token endpoint and asserts the
exact grant it sends.

The helpers stay source-compatible across regenerations: Go's `clientAuth` is
variadic, Java keeps a four-argument overload, and Python's `client_auth` is
last in the signature — so a call written against an earlier generation still
compiles and still means `client_secret_basic`.

A credential env var that is exported but **empty** is no credential at all —
the same reading the runtime gives it — so a blank `<SERVICE>_TOKEN` (what a
`.env` file or an unpopulated CI secret leaves behind) falls through to the
refresh rather than putting an empty bearer on the wire. The interactive
authorization-code step itself never runs inside a generated SDK: it is a
human-driven broker exchange run once, outside the serving path, and these
SDKs only ever replay or refresh the token that step already produced.

```ts
import { createRefreshingTokenProvider, PaymentsClient } from "@anvil-sdk/payments";

const client = new PaymentsClient({
  tokenProvider: createRefreshingTokenProvider("https://auth.example.com/token", {
    refreshToken: process.env.PAYMENTS_REFRESH_TOKEN,
    clientId: process.env.PAYMENTS_CLIENT_ID,
  }),
});
```

### Minting a client-credentials token (`oauth2_client_credentials`)

When the contract names a token endpoint (the payments example does), every
SDK can mint the service's own bearer the way the runtime does — the same
grant, to the same endpoint, under the same declared client authentication —
rather than waiting for an operator to paste a pre-minted `<SERVICE>_TOKEN`.
Precedence is the runtime's: an explicit token provider wins, then an explicit
client credential, then a static `<SERVICE>_TOKEN`, then the client credential
the environment names.

| Language | Explicit client credential | Standalone provider |
| --- | --- | --- |
| TypeScript | `{ clientCredentials: { clientId, clientSecret, scopes? } }` | `createClientCredentialsTokenProvider(tokenEndpoint, {...})` |
| Python | `client_id=`, `client_secret=`, `scopes=` | `create_client_credentials_token_provider(token_endpoint, client_id, client_secret, ...)` |
| Go | `WithClientCredentials(clientID, clientSecret, scopes...)` | `NewClientCredentialsTokenProvider(tokenEndpoint, clientID, clientSecret, ClientCredentialsOptions{...})` |
| Java | `.clientCredentials(clientId, clientSecret)` + `.scopes(...)` | `Oauth.clientCredentialsTokenProvider(tokenEndpoint, clientId, clientSecret, clientAuth, scopes, audience, resource)` |

The grant carries the contract's scopes (a caller may narrow them, never
widen), the contract's `audience`/`resource` when declared, and the client
authentication `provider.clientAuth` names — the same
`client_secret_basic`/`client_secret_post` table as the refresh helper above.
`private_key_jwt` is refused by every helper: nothing in an SDK mints an
RFC 7523 assertion, and the runtime's `<SERVICE>_CLIENT_SECRET` is not
something a private-key client has. The minted token is cached in memory
until shortly before it expires, and concurrent first calls share one mint
(a promise in TypeScript, a lock in Python, a mutex in Go, a monitor in Java)
rather than each opening a round trip.

```ts
const client = new PaymentsClient(); // reads PAYMENTS_CLIENT_ID / PAYMENTS_CLIENT_SECRET, mints, caches
```

`packages/generators/src/sdk-token-grants.test.ts` drives each language's real
client against a local token endpoint and asserts the exact grant it sends,
that the token is reused across calls, and that a static token still wins.

### On-behalf-of (`oauth2_on_behalf_of`, RFC 8693 token exchange)

An on-behalf-of contract acts under the inbound caller's authority. The SDK
never carries that caller's token upstream as-is: the caller supplies it as
the **subject token**, and the SDK exchanges it at the declared token endpoint
with its own client credential, the way the runtime's credential resolver
does for the same operation (`packages/runtime/src/credentials.ts`).

| Language | Per-caller client | Shared exchanger (one cache across subjects) |
| --- | --- | --- |
| TypeScript | `{ subjectToken, actorToken? }` | `createTokenExchanger(tokenEndpoint, {...}).tokenProvider(subjectToken, actorToken?)` |
| Python | `subject_token=`, `actor_token=` | `create_token_exchanger(token_endpoint, client_id, ...).token_provider(subject_token, actor_token)` |
| Go | `WithSubjectToken(...)`, `WithActorToken(...)` | `NewTokenExchanger(tokenEndpoint, clientID, clientSecret, TokenExchangeOptions{...}).TokenProvider(subject, actor)` |
| Java | `.subjectToken(...)`, `.actorToken(...)` | `Oauth.tokenExchanger(tokenEndpoint, clientId, clientSecret, clientAuth, options).tokenSupplier(subject, actor)` |

The grant is `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` with
the subject token under the contract's `subjectTokenType`
(`access_token` by default), the `requestedTokenType`, the declared
`audience`/`resource`/scopes, and — only when the contract's `delegation`
names an actor — `actor_token` from `<SERVICE>_ACTOR_TOKEN` (or the explicit
option) with `actor_token_type` `jwt`. A contract that names an actor refuses
to construct a client that has a subject but no actor, with `auth_required`,
rather than send a grant the runtime would refuse to send. Exchanged tokens
are cached per subject (and per actor) until shortly before they expire; two
subjects never share a token. The exchanger is emitted only when the contract
names a token endpoint.

```ts
const exchanger = createTokenExchanger(TOKEN_ENDPOINT, { clientId, clientSecret, clientAuth: TOKEN_CLIENT_AUTH });
const forAlice = new PaymentsClient({ tokenProvider: exchanger.tokenProvider(aliceInboundToken) });
```

## Safety rules

| Condition | Client behavior |
| --- | --- |
| Operation is not approved | No method is generated |
| Confirmation is required and absent | Refuse locally with `confirmation_required` |
| Caller-supplied idempotency key is required and absent | Refuse locally with `idempotency_required` |
| Mutation is not proven safe to retry | Do not retry it |
| `Retry-After` exceeds the retry ceiling | End the attempt budget and return the delay |
| Credential is present | Never include it in logs, errors, or exception text |

All four clients use the same Anvil error taxonomy. Errors include a code,
trace id, retryability, and whether retry is safe for that operation.

## Dry run

Every generated method can be previewed. A dry run runs the same local gates a
real call runs — the transport gate, confirmation, the idempotency
requirement, the retry-safety decision — and then returns the request plan
instead of sending it. It is the same plan `anvil run --dry-run` prints and
the MCP server returns for its reserved `anvil_dry_run` argument
(`packages/runtime/src/executor.ts`'s `DryRunPlan`), so a call can be
previewed on any surface and read the same way:

```json
{
  "operation": "payments.refunds.create",
  "method": "POST",
  "url": "https://api.example.com/payments/p_1/refunds",
  "headers": { "accept": "application/json", "content-type": "application/json", "Idempotency-Key": "refund-001" },
  "body": { "amount": 4200, "currency": "usd" },
  "idempotencyKeyPresent": true,
  "retryPlan": { "enabled": true, "maxAttempts": 3 },
  "confirmationRequired": true
}
```

| Language | Dry run | Plan type |
| --- | --- | --- |
| TypeScript | `{ dryRun: true }` in `CallOptions` | `DryRunPlan` |
| Python | `dry_run=True` (`anvil_dry_run=` when a business field is already called `dry_run`, the same allocation AIR gives `confirm`) | `dict` |
| Go | `CallOptions{DryRun: true}` | `map[string]any` |
| Java | `CallOptions.none().dryRun(true)` | `Map<String, Object>` |

Two rules hold in every language. A dry run never resolves a credential: no
static token is attached, no refresh or grant is minted, no token provider is
called — the runtime short-circuits before auth, and so does the SDK, which is
also what lets a call be previewed before any credential is configured.
Credential-bearing headers that do reach a plan (a modeled `cookie` or
`x-api-key` input, say) are redacted to `***`, the runtime's own set. And
every gate still runs: a dry run of a call the SDK would refuse is the same
refusal, not a plan. Omit `confirm` on a gated operation and the dry run
raises `confirmation_required` exactly as the real call would.

`packages/generators/src/sdk-compile.test.ts` previews the refund in all four
languages through a client whose token provider throws, asserts the four
plans are identical, and asserts the loopback upstream saw none of them.

## Call shape by language

These fragments show the generated refund method in each language. The
language-specific README contains the imports and client setup required for a
complete program. Safety controls remain separate from request data.

```ts
const client = new PaymentsClient({ token: process.env.PAYMENTS_TOKEN });
await client.createRefund(
  { payment_id: "pay_123", amount: 4200, currency: "usd" },
  { confirm: true, idempotencyKey: "refund-pay_123-001" },
);
```

```python
client = PaymentsClient()  # reads PAYMENTS_TOKEN
client.create_refund(
    payment_id="pay_123",
    amount=4200,
    currency="usd",
    confirm=True,
    idempotency_key="refund-pay_123-001",
)
```

```go
client, err := payments.New()
result, err := client.CreateRefund(
    ctx,
    payments.CreateRefundInput{
        PaymentId: "pay_123",
        Amount: 4200,
        Currency: "usd",
    },
    payments.CallOptions{
        Confirm: true,
        IdempotencyKey: "refund-pay_123-001",
    },
)
```

```java
PaymentsClient client = PaymentsClient.create();
client.createRefund(
    new CreateRefundInput("pay_123", 4200L, "usd"),
    CallOptions.none()
        .confirm(true)
        .idempotencyKey("refund-pay_123-001"));
```

Omit confirmation and each client refuses before opening a connection. Omit a
required caller key and each client returns `idempotency_required`.

## Response types

Request inputs are typed because they control what is sent. Responses are
decoded conservatively:

- TypeScript uses `unknown`;
- Python uses `Any`;
- Go uses `any`; and
- Java uses `Object`.

Many API descriptions omit or weaken response schemas. Anvil does not invent a
stronger response contract. Per-operation input JSON Schemas remain available
under `schemas/` in the bundle.

## Pagination and long-running operations

An operation with a declared pagination contract gets a paging helper in
every language: an async generator in TypeScript, a generator in Python, a
pager with `Next` in Go, and a bounded page collector in Java. All four
advance the same way for each style:

| Style | Continuation |
| --- | --- |
| `cursor` | The response's `nextField` token. |
| `page` | The response's `nextField` when declared, else the page number incremented while `itemsField` is non-empty. |
| `offset` | The response's `nextField` when declared, else the offset advanced by the number of items returned. |
| `link` | The `cursorParam` query value read out of the URL in `nextField`. The URL is never fetched, so paging cannot leave the compiled base URL. |

A requested page size above the contract's `maxPageSize` is clamped before
the request leaves. Every helper stops on a repeated continuation. A style
whose contract lacks the field it needs gets no helper, and `sdk/manifest.json`
records `paginated: false` for it rather than a helper that would guess.
Certification fails a manifest that drops a pager or a completion helper.
`packages/generators/src/sdk-compile.test.ts` drives the pager in all four
languages against a paging upstream and asserts they issued the same page
requests in the same order.

An operation with a complete asynchronous contract gets a `waitFor…` helper.
The helper polls the declared status operation until a declared terminal state.
An incomplete asynchronous contract produces no helper.

## Verify alignment

Run the package build for each language you plan to ship. Then verify the
bundle:

```bash
pnpm anvil certify generated/payments
```

Certification checks four properties:

1. `sdk/manifest.json` exposes exactly the approved operation set.
2. Confirmation, human-approval, idempotency, retry, and dry-run flags match
   AIR, and the manifest's `auth` block (carrier, env-var names, and any
   refresh, client-credentials, or token-exchange grant) is the one a fresh
   projection of AIR produces.
3. Every language has its required build files and generated methods.
4. Every language's source carries what the manifest promises: the dry-run
   plan on its one call path, and — for a contract that names a token
   endpoint — the grant helper, the client env-var names, the declared
   client authentication, and (for on-behalf-of) the RFC 8693 grant type and
   the actor env var.

`anvil conformance` is a separate check for agreement among the generated CLI,
MCP server, and skill. It does not execute the SDKs.

Generated bytes are deterministic. Editing a generated SDK invalidates
certification.

## Regenerate instead of patching

Change the source contract or reviewed Anvil manifest. Recompile the bundle.
Then rebuild or re-emit the SDKs.

Do not edit `sdk/` by hand. Anvil records the service version in each generated
package, but it does not publish the packages to a registry. Package release
and compatibility policy remain with the owning repository.

## Publish plans

`anvil sdk publish-plan <bundle>` prints, per language, the exact
rehearsal-then-publish commands and the preconditions each registry has,
read back from the generated package manifests (`package.json`,
`pyproject.toml`, `go.mod`, `pom.xml`) rather than re-derived. A plan never
names a version the package would not carry, and a mixed-version set is
refused (`sdk_version_mismatch`).

```bash
pnpm anvil sdk publish-plan generated/payments                 # the README
pnpm anvil sdk publish-plan generated/payments --json           # the plan object
pnpm anvil sdk publish-plan generated/payments \
  --lang typescript,python --out release/payments-sdk          # <lang>/publish-plan.json + PUBLISHING.md
```

| Language | Registry | Rehearsal | Mutating step | Credential names |
| --- | --- | --- | --- | --- |
| TypeScript | npm | `npm pack --dry-run`, `npm publish --dry-run` | `npm publish --access public` | `NPM_TOKEN` |
| Python | PyPI | `python3 -m build`, `twine check`, TestPyPI upload | `twine upload dist/*` | `TWINE_USERNAME`, `TWINE_PASSWORD`, `TWINE_REPOSITORY_URL` |
| Go | module proxy | `go mod tidy`, `go build`, `go vet` | `git tag vX.Y.Z && git push origin vX.Y.Z` | the runner's git identity, `GOPROXY`/`GOPRIVATE` |
| Java | Maven | `mvn -B verify`, staging deploy | `mvn -B deploy` to the release repository | `MAVEN_USERNAME`, `MAVEN_PASSWORD`, `MAVEN_GPG_PASSPHRASE` |

Credentials are named, never held: the plan lists environment-variable names
and the values stay in your secret store. Every step before the one marked
**MUTATES** runs without touching a registry, and Anvil itself makes no
network call to prepare the plan. The `--out` files land outside the bundle
because `sdk/` is compiler-owned: writing into it would invalidate
certification, exactly as with `anvil sdk --out`.

Read [wire protocol support](wire-protocols.md) before consuming a GraphQL,
SOAP, or gRPC-derived client.
