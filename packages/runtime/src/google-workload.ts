import type { AuthRequirement } from "@anvil/air";
import { GoogleAuth } from "google-auth-library";
import type { AuthMaterial } from "./auth.js";
import { CredentialUnavailableError } from "./vault.js";

/** Official ADC acquisition. Instances cache only within one reviewed connector/profile. */
export class GoogleWorkloadCredentials {
  private readonly providers = new Map<string, GoogleAuth>();

  constructor(
    private readonly createAuth: (scopes: string[]) => GoogleAuth = (scopes) =>
      new GoogleAuth({ scopes }),
  ) {}

  async resolve(connector: string, profile: string, auth: AuthRequirement): Promise<AuthMaterial> {
    if (auth.type !== "workload_identity" || auth.secretSource !== "workload_identity") {
      throw new CredentialUnavailableError(
        "Workload credentials require a reviewed workload_identity auth contract.",
        {
          code: "connector/unsupported_auth",
          connector,
        },
      );
    }
    const scopes = [...new Set(auth.scopes)].sort();
    const audience = auth.audience ?? auth.provider?.resource;
    const key = JSON.stringify([connector, profile, scopes, audience ?? null]);
    let provider = this.providers.get(key);
    if (!provider) {
      provider = this.createAuth(scopes);
      this.providers.set(key, provider);
    }
    try {
      if (audience) {
        const client = await provider.getIdTokenClient(audience);
        const headers = await client.getRequestHeaders(audience);
        const authorization = headers.get("authorization");
        if (authorization) return { headers: { Authorization: authorization } };
      } else {
        const token = await provider.getAccessToken();
        if (token) return { headers: { Authorization: `Bearer ${token}` } };
      }
    } catch {
      // Provider errors can contain credential material; expose only the failed boundary.
    }
    throw new CredentialUnavailableError(
      "Google ADC could not acquire the connector workload credential.",
      {
        code: "connector/refresh_failed",
        connector,
      },
    );
  }
}
