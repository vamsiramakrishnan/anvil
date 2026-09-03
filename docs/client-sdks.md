# Client SDKs

Anvil generates TypeScript, Python, Go, and Java clients from the same AIR
document as the CLI and MCP server.

The consequence is mechanical:

1. AIR defines the approved operation set and safety rules.
2. Every SDK is generated from AIR.
3. Therefore, an operation cannot require confirmation in one generated client
   and omit it in another.

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
| `api_key`, `basic`, `oauth2_client_credentials`, … (static bearer/API key) | A resolved token or key, in the carrier AIR declared (default `Authorization: Bearer` or `X-API-Key`) | `<SERVICE>_TOKEN` (or `_API_KEY`) | Unchanged by this page — the baseline every other scheme is described relative to. |
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
automatically when those env vars are present. The interactive
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

An operation with a declared pagination contract gets a paging helper. The
helper stops at the final page and rejects a repeated cursor.

An operation with a complete asynchronous contract gets a `waitFor…` helper.
The helper polls the declared status operation until a declared terminal state.
An incomplete asynchronous contract produces no helper.

## Verify alignment

Run the package build for each language you plan to ship. Then verify the
bundle:

```bash
pnpm anvil certify generated/payments
```

Certification checks three properties:

1. `sdk/manifest.json` exposes exactly the approved operation set.
2. Confirmation, human-approval, idempotency, and retry flags match AIR.
3. Every language has its required build files and generated methods.

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

Read [wire protocol support](wire-protocols.md) before consuming a GraphQL,
SOAP, or gRPC-derived client.
