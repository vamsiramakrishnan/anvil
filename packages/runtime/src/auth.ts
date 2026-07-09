import type { AuthRequirement } from "@anvil/air";
import type { HttpRequest } from "./transport.js";

/**
 * Resolved auth material. Secrets live here only transiently and are never
 * written to execution records or logs (spec §13, §18). Agents never see them.
 */
export interface AuthMaterial {
  /** Headers to merge into the outbound request (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Query params to merge (e.g. api_key for query-key APIs). */
  query?: Record<string, string>;
}

/**
 * Resolves a named auth profile into material. Implementations read from
 * approved stores only (Secret Manager, workload identity) — never from
 * agent-provided input, and never returning the raw secret to the caller.
 */
export interface CredentialResolver {
  resolve(profileName: string, auth: AuthRequirement): Promise<AuthMaterial | null>;
}

/**
 * Default resolver: reads a bearer token / api key from the process
 * environment by convention, e.g. profile `prod` -> ANVIL_PROD_TOKEN. Intended
 * for local dev; production binds Secret Manager behind this same interface.
 */
export class EnvCredentialResolver implements CredentialResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(profileName: string, auth: AuthRequirement): Promise<AuthMaterial | null> {
    const prefix = `ANVIL_${profileName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    const token = this.env[`${prefix}_TOKEN`];
    const apiKey = this.env[`${prefix}_API_KEY`];
    switch (auth.type) {
      case "none":
        return {};
      case "api_key":
        return apiKey ? { headers: { "X-API-Key": apiKey } } : null;
      case "basic": {
        const user = this.env[`${prefix}_USERNAME`];
        const pass = this.env[`${prefix}_PASSWORD`];
        if (!user || !pass) return null;
        const b64 = Buffer.from(`${user}:${pass}`).toString("base64");
        return { headers: { Authorization: `Basic ${b64}` } };
      }
      default:
        // All OAuth2 / JWT / bearer variants use a resolved bearer token here;
        // token acquisition/refresh is the resolver's responsibility upstream.
        return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
    }
  }
}

/** Apply resolved material to a request. Never logs the material. */
export function applyAuth(req: HttpRequest, material: AuthMaterial): HttpRequest {
  const headers = { ...req.headers, ...(material.headers ?? {}) };
  let url = req.url;
  if (material.query && Object.keys(material.query).length > 0) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(material.query)) u.searchParams.set(k, v);
    url = u.toString();
  }
  return { ...req, headers, url };
}
