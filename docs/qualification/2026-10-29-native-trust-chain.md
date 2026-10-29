# Native Google admission through an engine-issued connector turn

Live evidence, 29 October 2026: Anvil commit
`0f86655774f59e0219b51ea8fd9b3bea94da0425` and Branchyard binaries containing
identity commit `f92466fc` (integrated as `8e8cb678`) completed the full trust
chain in GKE. The task used Branchyard's existing fake ACP agent as a model-free
shell driver. All 14 in-turn assertions passed; the native operation succeeded
with one turn and `no_changes`. The [evidence](native-trust-20261029/evidence.json)
includes deployed binary hashes, selected audit fields, and cleanup receipts.
Not done: live human Workspace OAuth consent or refresh, a model-driven turn,
production MCP hosting, or Cloud Run authorization.

## What ran

This extends the [earlier qualification](2026-10-29-gke-wif-mcp.md) without changing
its record. That run used locally signed inbound gateway fixtures and checked
native Google admission separately. This extension used the real server and
engine for the entire path:

1. The allowed GKE workload obtained a Google metadata ID token for the exact
   configured server audience and submitted `POST /v1/repos/validation/tasks`.
   Branchyard verified Google issuer, numeric subject, and audience and returned
   HTTP 202. The binding supplied tenant `validation-20261029` and `read`/`run`
   scopes.
2. The server's gateway supervisor started the compiled Anvil fleet, created
   its signing key and public JWKS, and configured the gateway's issuer and
   audience. The qualification did not sign an inbound token.
3. The engine invoked real Anvil connector packaging, provisioned the generated
   package into the harness's private home, and wrote its signed turn token to
   the normal mode-0600 token file. The default effect proxy stayed enabled.
4. The fake ACP agent executed a qualification command in that provisioned
   environment. The command compiled the actual generated TypeScript SDK using
   the compiler shipped in the runtime artifact and invoked `StorageClient`.
   The SDK read the provisioned token and called the turn proxy.
5. Anvil verified the server-issued token and used Google's official ADC library
   with GKE workload identity. The real SDK MCP fixture submitted that workload
   bearer to Google Storage, where native bucket IAM permitted `objects.list`.
   The SDK result contained `probe.json`.

The pods had compiled artifacts and dependencies, with no Anvil checkout or ADC
credential file. Node was `v22.23.4`, GKE was `1.35.8-gke.1796000`, MCP SDK was
`1.32.1`, and `google-auth-library` was `11.3.1`. The fake agent did not implement
connector packaging, token signing, or gateway behavior. Its private harness
home is not a process sandbox.

## Identity and denial evidence

The in-turn check verified the issued token against the native server's public
JWKS. Its subject matched `google:` plus SHA-256 of the canonical JSON array
`[verified Google issuer, verified Google subject]`. Tenant and broker issuer
matched the server configuration; branch, turn, and read grant matched the
engine's provisioned turn.

The same generated SDK then called the fixture's confirmed operation with
confirmation supplied. That operation is conservatively classified as a
mutation in AIR; its captured upstream tool would only list objects. The
read-only grant caused Anvil to return `policy/grant_denied` before dispatch.
The live refusal's `principalId` exactly matched `by:v1:` plus SHA-256 of
`[verified broker issuer, tenant, derived subject]`, rather than the raw subject.
The upstream request counter did not increase.

The gateway audit recorded two calls for the same subject, tenant, branch, and
turn: the allowed read with upstream status 200, and the denied mutation with no
upstream status. The upstream executed captured tool `native.bucket.list`
exactly once. Its four MCP protocol requests each passed the real Google Storage
IAM check. A second workload with an unmapped Google subject received HTTP 401
when submitting the same task shape; it produced no gateway or upstream calls.

The protected upstream is a TLS qualification fixture backed by real Google
Storage authorization. This establishes native IAM on its data access; it does
not establish IAM-protected hosting of the MCP listener. The earlier run's
separate denied-workload test remains the native Storage 403 evidence.

## Resource scope and cleanup

The extension reused the approved names only after the earlier run's verified
cleanup. It created a fresh namespace, two new IAM service accounts with new
numeric IDs, their exact Kubernetes impersonation bindings, and one bucket.
Only the allowed account received `roles/storage.objectViewer` on that bucket.
Existing cluster settings, workloads, and project IAM were unchanged. The
protected validation VM and its services were not accessed.

The namespace was deleted and its absence confirmed. The bucket lookup returned
404 after deletion. Both IAM account deletions succeeded; individual lookups
reported absence, and the filtered project account list was empty. Temporary TLS
private files and the isolated kubeconfig were removed.

The [rerun procedure](native-trust-20261029/rerun.md) preserves the scripts and
resource boundaries. Public receipts omit cloud project and account identifiers,
bearer tokens, signing keys, vault contents, and TLS private material.
