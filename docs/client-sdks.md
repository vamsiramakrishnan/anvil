# Client SDKs

Anvil emits client SDKs for **TypeScript, Python, Go, and Java** from the same
AIR document that produces the CLI, the MCP server, and the skill. They are not
a side artifact: they are the fourth surface, and they are certified like the
others.

The point is not that Anvil can generate code — many tools do. The point is that
the Go service, the Python notebook, the CLI, and the agent are all calling the
*same* contract, with the same gates, under names derived one way. A refund
cannot require confirmation in the CLI and quietly omit it from the Java client.

## Where they come from

`anvil compile` writes them into the bundle:

```
sdk/
  manifest.json          # the language-neutral index every emitter reads
  README.md              # the cross-language contract
  typescript/            # zero-dependency ESM over the platform fetch
  python/                # zero-dependency package over urllib
  go/                    # zero-dependency module over net/http
  java/                  # Java 11+, java.net.http plus a bundled JSON codec
```

`anvil sdk <bundle>` prints what the four expose and the gates each call must
satisfy. `anvil sdk <bundle> --out <dir>` re-emits the trees somewhere else — a
monorepo's `clients/`, a vendored copy — and `--lang go,python` narrows the set.
`anvil sdk <bundle> --json` emits the manifest as an operator envelope.

Every SDK is dependency-free on purpose. An SDK you can copy into a repository
and compile with the toolchain already there is worth more than one that needs a
resolver before it can say hello.

## What every SDK enforces, identically

1. **Only approved operations exist.** An operation still in review has no
   method in any language. The refusal is structural, not a runtime check —
   there is no name to call.
2. **Confirmation gates run before the wire.** An operation whose contract
   requires confirmation refuses locally; nothing is sent. Operations needing
   human approval say so, rather than letting a caller self-confirm. In Java the
   convenience overload does not exist for a gated operation, so forgetting the
   gate is a compile error.
3. **Idempotency keys where the contract requires them.** Derived
   (`anvil-<fingerprint>`, the same derivation the runtime uses) where the
   contract allows derivation; demanded from the caller where it does not.
4. **Non-idempotent mutations are never retried.** The retry gate is
   `retryIsSafe` — the same predicate the Anvil runtime applies. A transient
   failure on a mutation that cannot prove idempotence surfaces as
   `unsafe_retry_blocked`, not as a possible duplicate write.
5. **`Retry-After` is honored as a floor.** An upstream asking for longer than
   the client's ceiling ends the attempt budget and hands back the delay it
   asked for, instead of knocking again early.
6. **One error taxonomy.** Every failure carries an Anvil error code, a trace
   id, and whether it is retryable — in all four languages.
7. **Credentials never appear in an error, a log, or a message.** A transport
   failure reports that it could not reach the upstream; it never echoes the URL,
   because the URL can carry a query-carried credential.

## What a call looks like

The same refund, in four languages. Note that the safety controls are a separate
argument everywhere: they are not request data, and they decide whether a
request happens at all.

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
    payment_id="pay_123", amount=4200, currency="usd",
    confirm=True, idempotency_key="refund-pay_123-001",
)
```

```go
client, err := payments.New()
result, err := client.CreateRefund(ctx,
    payments.CreateRefundInput{PaymentId: "pay_123", Amount: 4200, Currency: "usd"},
    payments.CallOptions{Confirm: true, IdempotencyKey: "refund-pay_123-001"})
```

```java
PaymentsClient client = PaymentsClient.create();
client.createRefund(
    new CreateRefundInput("pay_123", 4200L, "usd"),
    CallOptions.none().confirm(true).idempotencyKey("refund-pay_123-001"));
```

Omit `confirm` and every one of them refuses with `confirmation_required`
before opening a socket. Omit the idempotency key and every one of them refuses
with `idempotency_required`.

## Paging and long-running work

An operation whose AIR declares pagination gets a paging variant that stops when
the upstream stops handing back a continuation — and stops if the upstream
echoes a cursor it already gave, rather than paging the same page forever.

An operation whose AIR declares a *resolvable* async contract gets a
`waitFor…` helper that polls the declared status operation until a declared
terminal state. A contract that only half-resolves produces no helper at all:
an SDK that hands you a poller pointing at a method that does not exist is worse
than one that hands you nothing.

## What the SDKs do not do

They decode responses permissively — `unknown` in TypeScript, `Any` in Python,
`any` in Go, `Object` in Java. Response schemas in real specifications are
frequently absent or partial, which is what Anvil's refinement loop exists to
address; typing a response the contract never actually promised would be the
same guessing Anvil is built to stop. Request inputs, where correctness and
safety live, are fully typed. The per-operation response schemas AIR *does*
carry are shipped in the bundle under `schemas/`.

## How the SDKs stay honest

Three certification gates cover them, and `anvil certify` runs all three:

- `contract.surfaces-agree` includes `sdk/manifest.json`, so the four SDKs must
  expose exactly the approved operation set — the same check that holds the CLI,
  the MCP server, the catalog, and the runtime manifest together.
- `safety.sdk-gates-match` re-derives the manifest from AIR and refuses any
  difference in confirmation, human-approval, idempotency, or retry flags. It
  also proves each language's own source defines the method the manifest names.
- `runtime.sdk-present` requires a buildable tree per language, not just rows in
  a manifest — a missing `go.mod` is the difference between an SDK you can
  vendor and a directory you cannot compile.

`contract.generated-bytes-agree` covers the rest: the emitted source is a
deterministic projection of AIR, so an edited SDK file fails certification.
Edit AIR or the Anvil manifest and regenerate; never edit `sdk/`.
