import { createHash } from "node:crypto";
import { type AirDocument, IdentityProfile, operationInputSchema } from "@anvil/air";
import type { TargetKitFile } from "./model.js";

/** Pure projection: reuse the same profile across bundles; validate exact local bindings. */
export function generateIdentityKit(
  air: AirDocument,
  raw: unknown,
): { files: TargetKitFile[]; digest: string } {
  const profile = IdentityProfile.parse(raw);
  const local = profile.authorization.rules.filter((rule) => rule.service === air.service.id);
  for (const rule of local)
    for (const id of rule.operations) {
      const operation = air.operations.find((operation) => operation.id === id);
      if (!operation)
        throw new Error(`Identity rule ${rule.id} references unknown operation ${id}`);
      if (
        rule.effect === "allow" &&
        !profile.mapping.upstreamScopes.includes("*") &&
        operation.auth.scopes.some((scope) => !profile.mapping.upstreamScopes.includes(scope))
      )
        throw new Error(
          `Identity rule ${rule.id} does not grant the upstream scopes required by ${id}`,
        );
      const properties = operationInputSchema(operation).properties ?? {};
      for (const constraint of rule.constraints) {
        if (!Object.hasOwn(properties, constraint.input))
          throw new Error(`Identity rule ${rule.id} constrains an unknown input on ${id}`);
      }
    }
  if (profile.authorization.adapter === "rules" && !local.some((rule) => rule.effect === "allow"))
    throw new Error("Identity profile has no allow binding for this service");
  const serialized = JSON.stringify(profile);
  const digest = createHash("sha256").update(serialized).digest("hex");
  const file = (name: string, value: unknown): TargetKitFile => ({
    path: `targets/identity/${name}`,
    bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
  });
  return {
    digest,
    files: [
      file("setup.json", { config: profile }),
      file("profile.json", profile),
      file("env.json", { ANVIL_IDENTITY_PROFILE_JSON: serialized }),
      file("terraform.tfvars.json", { env: { ANVIL_IDENTITY_PROFILE_JSON: serialized } }),
      file("binding.json", {
        version: 1,
        profile: profile.id,
        sha256: digest,
        service: air.service.id,
        operations: local.flatMap((rule) => rule.operations),
        adapter: profile.authorization.adapter,
        verifiedLive: false,
      }),
      {
        path: "targets/identity/README.md",
        bytes: Buffer.from(
          `# Identity profile ${profile.id}\n\nProfile SHA-256: ${digest}\n\nMerge terraform.tfvars.json env into the existing deployment variables; preserve unrelated environment settings. Remove ANVIL_INBOUND_* overrides. For local serving set ANVIL_IDENTITY_PROFILE to the absolute profile.json path instead. Custom authorization adapters must be loaded through ANVIL_EXTENSIONS before boot.\n\nCloud Run: keep IAM invocation and application identity separate. Callers may use X-Serverless-Authorization for the platform ID token and Authorization for the end-user access token. Anvil never trusts the platform header as user identity. IAP profiles verify x-goog-iap-jwt-assertion using IAP keys and the exact backend audience; IAP assertions are never exchanged downstream.\n\nUse attached service accounts on Cloud Run or Workload Identity Federation for GKE for outbound Google APIs. No service-account key is needed. Identity configuration does not grant IAM roles, provision an OAuth client, or prove a live SiteMinder integration. Certify the bundle after generating this kit.\n`,
        ),
      },
    ],
  };
}
