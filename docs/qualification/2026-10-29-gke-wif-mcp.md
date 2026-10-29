# GKE workload identity and protected MCP qualification

Live evidence, 29 October 2026: Anvil commit `0f86655774f59e0219b51ea8fd9b3bea94da0425`
ran in GKE Autopilot through the compiled CLI. Node was `v22.23.4`, GKE was
`1.35.8-gke.1796000`, the MCP SDK was `1.32.1`, and `google-auth-library` was
`11.3.1`. Results, binary hashes, and cleanup checks are in
`docs/qualification/gke-wif-20261029/evidence.json`. Not done: live human OAuth
consent or refresh, Cloud Run authorization, a production MCP provider, or a
model-driven turn in this qualification.

## Credential and permission path

The run used one new namespace in an existing cluster, two new IAM service
accounts mapped to distinct Kubernetes service accounts, and one new bucket.
Only the allow service account received `roles/storage.objectViewer` on that
bucket. The new service-account policies permitted impersonation by their exact
namespace and Kubernetes account. Project IAM and cluster settings were unchanged.

Anvil obtained credentials through the GKE metadata service and Google's official
ADC library. The pods had no ADC file or Anvil checkout. The deployed package's
symlinks stayed inside the artifact.

The upstream was a TLS-protected qualification fixture built with the real MCP
SDK. It forwarded the workload bearer to Google's Storage API for
`objects.list`. Google verified the credential and enforced bucket IAM. This
proves native IAM on the tool's actual data access. It does not establish
IAM-protected hosting for the MCP listener itself.

The gateway's inbound Branchyard tokens were local signed fixtures. Separate
checks exercised native Branchyard Google admission with real metadata ID
tokens. This run did not mint an Anvil turn token through that admitted server.

## Observed results

| Check | Observed result |
| --- | --- |
| Allowed workload through the compiled gateway | The tool returned `probe.json` from the real bucket. |
| Denied workload through the same gateway configuration | Google Storage returned 403. The tool handler did not execute. |
| Grant and confirmation refusals | Both identities produced zero upstream requests for the refused calls. |
| Public tool rename | `storage__public_bucket_list` dispatched captured name `native.bucket.list`. |
| Denied upstream call | One native 403 request; no automatic replay. |
| Google server admission | A real token with the configured issuer, subject, and audience reached `/v1/repos` with 200. |
| Configured server scope | That read-only principal received 403 from `/metrics`. |
| Wrong token audience | The native server returned 401. |
| Unmapped service-account subject | The native server returned 401. |

The Branchyard binaries included identity commit `f92466fc`, integrated as
`8e8cb678`. Their deployed SHA-256 hashes matched the copied build artifacts.

## Cleanup

The namespace was deleted and its absence confirmed. The bucket and probe object
were deleted; a subsequent bucket lookup returned 404. Both service-account
deletions succeeded, and the project account list confirmed both absent.
One immediate account lookup briefly returned stale data after deletion, so the
absence check was repeated. Temporary TLS private files and kubeconfigs were
removed. The existing validation VM and its services were not accessed.

The [rerun procedure](gke-wif-20261029/rerun.md) preserves the fixture scripts and
resource boundaries. Public evidence omits project, cluster, and account
identifiers, credentials, and private key material.
