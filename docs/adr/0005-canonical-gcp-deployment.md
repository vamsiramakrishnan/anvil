# ADR-0005 — Canonical GCP deployment path (one owner per concern)

**Status:** Accepted

## Context
`generateDeploy` emitted 15 files with **five owners for the same settings**: a
knative `cloudrun.service.yaml`, an `iam.plan.json`, per-env `overlays/`, a
`gcloud run deploy` step in Cloud Build, *and* Terraform. The image tag was set
three incompatible ways; env vars came from four sources; `cloudrun.service.yaml`
carried literal `PROJECT`/`REGION` placeholders and was never applied. Nothing
reconciled them — they drift by construction.

## Decision
One owner per concern:
- **Terraform** owns all infrastructure *and* runtime configuration — service
  account, Artifact Registry, Secret Manager + IAM, Firestore ledger + IAM, the
  Cloud Run service (image, env vars, scaling, resources, ingress), invoker IAM.
- **Cloud Build** owns the pipeline only — build, push, `terraform apply` with the
  built image tag. It sets no env vars, IAM, or scaling.
- **Dockerfile** owns the container (prebuilt runtime; never rebuilds Anvil).

**Deleted:** `cloudrun.service.yaml`, `iam.plan.json`, `overlays/*.env.yaml`,
`artifact-metadata.json`.

## Consequences
- The image tag has exactly one source (Cloud Build → Terraform var); env vars,
  IAM, and scaling each have exactly one owner. No hand-synchronization.
- No literal `PROJECT`/`REGION` placeholders — everything flows through Terraform
  variables, so the bundle applies as emitted. A test asserts the deleted files
  stay deleted and Cloud Build sets no runtime config.
