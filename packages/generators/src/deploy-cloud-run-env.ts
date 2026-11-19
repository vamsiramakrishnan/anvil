/** Terraform blocks for injecting runtime environment and granting access to referenced secrets. */
export const cloudRunEnvironment = {
  preconditions: `    precondition {
      condition = length(setintersection(
        toset(keys(var.env)),
        local.anvil_compiler_owned_runtime_env_names,
      )) == 0
      error_message = "var.env may not redefine compiler-owned ANVIL runtime settings."
    }
    precondition {
      condition = length(setintersection(
        toset(keys(var.credential_secret_refs)),
        local.anvil_compiler_owned_runtime_env_names,
      )) == 0
      error_message = "credential_secret_refs may not redefine compiler-owned ANVIL runtime settings."
    }
    precondition {
      condition = length(setintersection(
        toset(keys(var.secret_env_refs)),
        setunion(local.anvil_compiler_owned_runtime_env_names, toset(keys(var.env)), toset(keys(var.credential_secret_refs))),
      )) == 0
      error_message = "secret_env_refs may not override compiler-owned, plain, or runtime-resolved environment variables."
    }
    precondition {
      condition = length(setintersection(
        toset(keys(var.env)),
        toset(keys(var.credential_secret_refs)),
      )) == 0
      error_message = "One runtime environment variable may not be supplied by both var.env and credential_secret_refs."
    }`,
  container: `      # Additional plain env — a connector target injects its inbound-auth
      # contract (ANVIL_INBOUND_*) here so the server self-enforces the platform's
      # token. Empty by default.
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }
      # Cloud Run resolves each pinned Secret Manager version into this variable at startup.
      dynamic "env" {
        for_each = var.secret_env_refs
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret
              version = env.value.version
            }
          }
        }
      }
      # Upstream credential *references* as PLAIN env: the VALUE is a Secret
      # Manager resource name (sm://…), which the runtime dereferences at call
      # time and TTL-caches — so 'latest' rotates without a new revision. Grant
      # this SA access via var.credential_secret_ids below. See
      # deploy/credentials.required.yaml for exactly which keys this surface reads.
      dynamic "env" {
        for_each = var.credential_secret_refs
        content {
          name  = env.key
          value = env.value
        }
      }`,
  secretIam: `# Scoped read access to each upstream credential secret referenced by
# var.credential_secret_refs (client secrets, assertion keys, bearer tokens).
# One binding per secret — never a project-wide secret role. Pass the secret IDs
# (projects/P/secrets/S) so the binding is explicit and least-privilege.
resource "google_secret_manager_secret_iam_member" "runtime_reads_credential" {
  for_each  = setunion(toset(var.credential_secret_ids), toset([for ref in values(var.secret_env_refs) : ref.secret]))
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:\${google_service_account.runtime.email}"
}`,
  secretVariables: `# Upstream credential references as PLAIN env: ENV_NAME → Secret Manager resource
# name (sm://projects/P/secrets/S/versions/latest). The runtime dereferences and
# TTL-caches them, so 'latest' rotates without a redeploy. Names, never values.
variable "credential_secret_refs" {
  type    = map(string)
  default = {}
}
# Native Cloud Run bindings for code that reads secret values from environment variables.
variable "secret_env_refs" {
  type    = map(object({ secret = string, version = string }))
  default = {}
  validation {
    condition = alltrue([for name, ref in var.secret_env_refs :
      can(regex("^[A-Za-z_][A-Za-z0-9_]*$", name)) &&
      can(regex("^projects/[A-Za-z0-9-]+/secrets/[A-Za-z0-9_-]+$", ref.secret)) &&
      can(regex("^[1-9][0-9]*$", ref.version))
    ])
    error_message = "Use an environment variable name, a projects/P/secrets/S resource and a numeric, pinned secret version."
  }
}
# Secret IDs (projects/P/secrets/S) this SA may read — one scoped secretAccessor
# binding each. Provide the secrets backing credential_secret_refs here.
variable "credential_secret_ids" {
  type    = list(string)
  default = []
}`,
} as const;
