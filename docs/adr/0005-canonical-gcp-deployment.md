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
- **Terraform** owns every *per-capability* setting — service account, Secret
  Manager + IAM, ledger IAM, the Cloud Run service (image, env vars, scaling,
  resources, ingress), invoker IAM. It sets nothing that a second file also sets.
- **Cloud Build** owns the pipeline only — build, push, and `terraform plan` with
  the built image tag. It sets no env vars, IAM, or scaling.
- **Dockerfile** owns the container (prebuilt runtime; never rebuilds Anvil).

**Deleted:** `cloudrun.service.yaml`, `iam.plan.json`, `overlays/*.env.yaml`,
`artifact-metadata.json`.

### Deployability (must actually apply from a clean project)
- **Shared singletons are prerequisites, not generated.** The Artifact Registry
  repo and the Firestore `(default)` database (one per project) are *not* created
  by the per-capability module — creating them per capability collides, and
  generating the AR repo created a bootstrap cycle where `docker push` needed a
  repo a later Terraform step had not applied yet. They are documented prereqs.
- **Remote state is mandatory.** Terraform declares a `backend "gcs"` bound at
  `init -backend-config=…`, so an ephemeral build container never starts from
  empty state and tries to recreate live resources.
- **No auto-apply.** Cloud Build runs `terraform plan -out=tfplan` and publishes
  the plan; apply is a separate promoted step behind review, because a capability
  deploy can change IAM, ingress, and secrets. Dev may auto-apply the plan.

## Consequences
- The image tag has exactly one source (Cloud Build → Terraform var); env vars,
  IAM, and scaling each have exactly one owner. No hand-synchronization.
- No literal `PROJECT`/`REGION` placeholders — everything flows through Terraform
  variables. Tests assert the deleted files stay deleted, Cloud Build sets no
  runtime config and never auto-applies, remote state is configured, and the
  shared singletons are not recreated.
