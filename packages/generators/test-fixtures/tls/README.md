# mTLS test fixtures

Self-signed test certificates for the generated SDKs' mutual-TLS transport
(`sdk/typescript/src/mtls.ts`, `_mtls.py`, `mtls.go`, `Mtls.java`). Used only
by `packages/generators/src/sdk-mtls-smoke.test.ts` and the mTLS fixtures in
`sdk.test.ts` / `sdk-compile.test.ts`. Never reuse these outside tests — the
private keys are checked in on purpose, for a throwaway CA nobody else trusts.

If `packages/runtime/test-fixtures/tls/` exists when you read this, prefer
it — this directory exists only because it did not exist yet when this lane
needed one, per the coordination note in `laneA2-sdk-auth-parity.md`.

## Files

| File | Purpose |
| --- | --- |
| `ca-cert.pem` | Root of the test-only trust chain. Its private key is not checked in — it signed the two certs below and is no longer needed. |
| `server-cert.pem` / `server-key.pem` | The test HTTPS server's certificate, `CN=127.0.0.1`, signed by the CA, with a `subjectAltName=IP:127.0.0.1` (Node and Go verify against the SAN, not the CN). |
| `client-cert.pem` / `client-key.pem` | The client certificate the generated SDKs present, `CN=anvil-sdk-client`, in original (server: PKCS#1, client: PKCS#1) form — accepted by `node:https`, Python's `ssl`, and Go's `tls.X509KeyPair` directly. |
| `server-key-pkcs8.pem` / `client-key-pkcs8.pem` | The same two private keys, converted to PKCS#8. The Java SDK's `Mtls.java` only parses PKCS#8 (`-----BEGIN PRIVATE KEY-----`) with `java.security.KeyFactory` — a traditional PKCS#1 RSA key must be converted first, and these are that conversion, checked in so the Java-facing tests need no `openssl` on the machine that runs them. |

Expiry: 3650 days from generation (2026-09-03) — long enough that this
fixture should never need mid-project renewal, but it is not permanent;
regenerate past 2036 with the recipe below.

## Regenerating

```bash
cd packages/generators/test-fixtures/tls

# CA (private key discarded after signing — not checked in)
openssl req -x509 -newkey rsa:2048 -keyout ca-key.pem -out ca-cert.pem \
  -days 3650 -nodes -subj "/CN=Anvil SDK Test CA"

# Server cert, SAN'd for 127.0.0.1
openssl req -newkey rsa:2048 -keyout server-key.pem -out server.csr \
  -nodes -subj "/CN=127.0.0.1"
echo "subjectAltName=IP:127.0.0.1" > server-ext.cnf
openssl x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial -out server-cert.pem -days 3650 -extfile server-ext.cnf

# Client cert
openssl req -newkey rsa:2048 -keyout client-key.pem -out client.csr \
  -nodes -subj "/CN=anvil-sdk-client"
openssl x509 -req -in client.csr -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial -out client-cert.pem -days 3650

# PKCS#8 conversions for the Java SDK
openssl pkcs8 -topk8 -nocrypt -in server-key.pem -out server-key-pkcs8.pem
openssl pkcs8 -topk8 -nocrypt -in client-key.pem -out client-key-pkcs8.pem

rm -f server.csr client.csr ca-cert.srl server-ext.cnf ca-key.pem
```
