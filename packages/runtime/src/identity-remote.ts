import { GoogleAuth } from "google-auth-library";
import type { IdentityAuthorizer } from "./identity.js";

export interface RemoteIdentityAuthorizerOptions {
  /** Operator-pinned endpoint. Never taken from a token or invocation argument. */
  endpoint: string;
  /** Cloud Run service URL or configured custom audience. Defaults to endpoint origin. */
  audience?: string;
  /** Injectable for tests; production uses ADC (Cloud Run SA / GKE federation / local ADC). */
  idToken?: (audience: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/** A reusable Cloud Run policy/SiteMinder-bridge client. No service-account key files. */
export function createGoogleIdentityAuthorizer(
  options: RemoteIdentityAuthorizerOptions,
): IdentityAuthorizer {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash)
    throw new Error("Identity policy endpoint must be HTTPS without credentials or fragment");
  const audience = options.audience ?? endpoint.origin;
  const auth = new GoogleAuth();
  const idToken =
    options.idToken ??
    (async (target: string) => {
      const client = await auth.getIdTokenClient(target);
      return client.idTokenProvider.fetchIdToken(target);
    });
  const send = options.fetchImpl ?? fetch;
  return async (context) => {
    const token = await idToken(audience);
    context.signal.throwIfAborted();
    const response = await send(endpoint, {
      method: "POST",
      redirect: "error",
      signal: context.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        principal: context.principal,
        service: context.service,
        operation: { id: context.operation.id, effect: context.operation.effect },
        input: context.input,
        confirmed: context.confirmed,
        traceId: context.traceId,
      }),
    });
    if (!response.ok || !response.body) throw new Error("Identity policy service unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536) throw new Error("Identity policy response exceeds limit");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    // The common runtime validates the decision and every obligation before allowing a call.
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
}
