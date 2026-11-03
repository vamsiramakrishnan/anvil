import type { IdentityProfile } from "@anvil/air";

type Authentication = IdentityProfile["authentication"];
export type TokenIntrospector = (token: string, fetchImpl?: typeof fetch) => Promise<unknown>;

/** Capture deployment credentials once. The returned function contains no serializable secrets. */
export function createTokenIntrospector(
  auth: Authentication,
  env: NodeJS.ProcessEnv,
): TokenIntrospector {
  const config = auth.introspection;
  if (!config) throw new Error("Introspection configuration is required");
  const clientId = env[config.clientIdEnv];
  const clientSecret = env[config.clientSecretEnv];
  if (!clientId?.trim() || !clientSecret?.trim())
    throw new Error("Introspection client credentials are not configured");
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash)
    throw new Error("Introspection endpoint must be HTTPS without credentials or fragment");
  return async (token, fetchImpl = fetch) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Introspection timed out"));
      }, config.timeoutMs);
    });
    const request = async () => {
      const body = new URLSearchParams({ token, token_type_hint: "access_token" });
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      };
      if (config.clientAuth === "client_secret_post") {
        body.set("client_id", clientId);
        body.set("client_secret", clientSecret);
      } else {
        // RFC 6749 section 2.3.1: encode each credential before constructing Basic.
        const encoded = (value: string) => new URLSearchParams({ x: value }).toString().slice(2);
        headers.authorization = `Basic ${Buffer.from(`${encoded(clientId)}:${encoded(clientSecret)}`).toString("base64")}`;
      }
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: body.toString(),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("Introspection service unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 65536) throw new Error("Introspection response exceeds limit");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return normalizeResponse(raw, auth, clientId);
    };
    try {
      return await Promise.race([request(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  };
}

function normalizeResponse(raw: unknown, auth: Authentication, clientId: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Introspection response must be an object");
  const claims = { ...(raw as Record<string, unknown>) };
  if (
    claims.active !== true ||
    claims.iss !== auth.issuer ||
    typeof claims.sub !== "string" ||
    !claims.sub.trim() ||
    typeof claims.token_type !== "string" ||
    !["bearer", "access_token"].includes(claims.token_type.toLowerCase())
  )
    throw new Error("Introspection did not establish an access-token identity");
  for (const key of ["exp", "nbf", "iat"]) {
    // SiteMinder emits NumericDate strings. Accept only canonical nonnegative integers.
    if (typeof claims[key] === "string" && /^(0|[1-9]\d*)$/.test(claims[key] as string))
      claims[key] = Number(claims[key]);
    if (
      claims[key] !== undefined &&
      (typeof claims[key] !== "number" || !Number.isSafeInteger(claims[key]))
    )
      throw new Error("Introspection timestamp is invalid");
  }
  if (typeof claims.exp !== "number") throw new Error("Introspection expiration is required");
  if (claims.aud === undefined && auth.introspection?.audienceSource === "dedicated_client") {
    // This is an explicit reviewed exclusive-client/resource binding, not an inferred audience.
    if (claims.client_id !== clientId || !auth.requiredScopes.length)
      throw new Error("Introspection client does not establish the resource binding");
    claims.aud = auth.audience;
  }
  // The common verifier checks the complete shape, audience, expiry and every required scope.
  return claims;
}
