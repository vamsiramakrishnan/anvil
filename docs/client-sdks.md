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
