# Rerun the native trust-chain extension

Use the resource boundaries and prerequisites in the earlier
[GKE procedure](../gke-wif-20261029/rerun.md). Run this extension in a fresh record
directory after confirming the earlier namespace, bucket, and service accounts
are absent. The fixed resource names are deliberately the same; never run both
qualifications concurrently.

Build Anvil and supply the compiled Branchyard `by`, `branchyard-server`, and
`fake-acp-agent` binaries through `BRANCHYARD_BIN_DIR`. The fake ACP agent is the
repository's model-free qualification driver. It executes a shell command using
the real provisioned turn environment. It does not simulate connector packaging,
token issuance, the gateway, or Google APIs.

Set `ANVIL_SOURCE`, `ANVIL_WIF_PROJECT`, `ANVIL_WIF_RECORD_DIR`, and an isolated
`KUBECONFIG` as documented in the earlier procedure. Then run:

```sh
python3 "$ANVIL_SOURCE/docs/qualification/native-trust-20261029/stage.py"
python3 "$ANVIL_WIF_RECORD_DIR/scripts/manage.py" create
python3 "$ANVIL_WIF_RECORD_DIR/scripts/deploy.py"
kubectl -n by-atomic-wif-20261029 exec allow-20261029 -- node /work/runtime/qualification/trust-driver.mjs
kubectl -n by-atomic-wif-20261029 exec deny-20261029 -- node /work/runtime/qualification/trust-driver.mjs
kubectl -n by-atomic-wif-20261029 exec allow-20261029 -- node /work/runtime/qualification/audit-check.mjs
```

Wait for the native server health endpoint before running the drivers. The
allow driver obtains a Google metadata ID token for the configured audience,
submits a real server task, and uses the native long-poll operation API. The
server supervises Anvil and creates its signing key and public JWKS. The engine
packages and provisions the connector, signs a turn token, and starts the
existing fake ACP agent in an isolated harness home. The qualification command
compiles the actual generated TypeScript SDK using the compiler already shipped
in the staged runtime. Calls use that SDK and the default effect proxy.

Only the provisioned token file is read, in memory, to verify its signature
against the native public JWKS. No signing key or upstream bearer is inspected.
The token is never printed. The successful read reaches real Google Storage IAM.
The denied operation is classified as a mutation in the reviewed fixture AIR;
its captured upstream tool would only list objects, and the grant refusal
prevents dispatch altogether. Its actual refusal supplies the owner namespace
for comparison with the verified issuer, tenant, and derived subject.

Save the redacted driver output and binary hashes, then clean up even if the
checks fail:

```sh
python3 "$ANVIL_WIF_RECORD_DIR/scripts/manage.py" cleanup
```

Verify `cleanupComplete` and the absence receipts. Remove the local temporary
TLS private directory and isolated kubeconfig. Never export the vault, bearer
token files, signing key, or Kubernetes Secret objects.
