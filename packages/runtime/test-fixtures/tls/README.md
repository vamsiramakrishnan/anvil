# mTLS test fixtures

Self-signed test-only PKI for exercising the runtime's `node:https` client-cert
transport path (`packages/runtime/src/transport.ts`) against a REAL local TLS
server, not a mock. Nothing here is a real secret — this is a throwaway CA and
a matching server/client certificate pair, valid for 10 years, generated once
with the commands below. **Never reuse these files outside this package's own
tests** (`transport.test.ts`, `auth.test.ts`): they are checked in specifically
so tests are hermetic and reproducible without regenerating certs on every run.

## Files

| File | Role |
| --- | --- |
| `ca-cert.pem` / `ca-key.pem` | The test CA. Tests trust `ca-cert.pem` to verify the server cert (self-signed, so nothing else would). |
| `server-cert.pem` / `server-key.pem` | Signed by the test CA, SAN `localhost` + `127.0.0.1`, `serverAuth` EKU. Used by the in-test `https.createServer`. |
| `client-cert.pem` / `client-key.pem` | Signed by the test CA, `clientAuth` EKU. Used as `AuthMaterial.tls` to prove the runtime presents a client certificate. |

## Regenerating

Only needed if the certs expire (they don't until 2036) or the SAN/EKU shape
needs to change. From this directory:

```bash
# CA
openssl genrsa -out ca-key.pem 2048
openssl req -x509 -new -nodes -key ca-key.pem -sha256 -days 3650 \
  -subj "/O=Anvil Test Fixtures/CN=Anvil Test CA" -out ca-cert.pem

# Server cert (SAN required — Node's TLS verifies against it, not the CN)
openssl genrsa -out server-key.pem 2048
openssl req -new -key server-key.pem -subj "/O=Anvil Test Fixtures/CN=localhost" -out server.csr
cat > server-ext.cnf <<'EOF'
subjectAltName = DNS:localhost,IP:127.0.0.1
extendedKeyUsage = serverAuth
EOF
openssl x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -out server-cert.pem -days 3650 -sha256 -extfile server-ext.cnf

# Client cert (what the runtime presents for mtls)
openssl genrsa -out client-key.pem 2048
openssl req -new -key client-key.pem -subj "/O=Anvil Test Fixtures/CN=anvil-test-client" -out client.csr
cat > client-ext.cnf <<'EOF'
extendedKeyUsage = clientAuth
EOF
openssl x509 -req -in client.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -out client-cert.pem -days 3650 -sha256 -extfile client-ext.cnf

rm -f server.csr client.csr server-ext.cnf client-ext.cnf ca-cert.srl
```
