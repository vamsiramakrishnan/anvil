import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type AirDocument,
  ENTERPRISE_OAUTH_CONTROL_SCOPE,
  enterpriseOAuthControlAudience,
  type IdentityProfile,
} from "@anvil/air";
import {
  createEnterpriseTokenVerifier,
  createTokenIntrospector,
  EnterpriseGrantStore,
  EnterpriseOAuthError,
  EnterpriseOAuthFlow,
  enterpriseCredentialResolver,
  enterpriseOAuthNamespace,
  loadEnterpriseOAuthBinding,
  mapIdentity,
  vaultFromEnv,
} from "@anvil/runtime";
import { type InboundAuthConfig, inboundIdentityFrom, verifyInboundToken } from "./inbound-auth.js";

const BROWSER_COOKIE = "__Host-anvil_connect";
const COOKIE_ATTRIBUTES = "; Path=/; HttpOnly; Secure; SameSite=Lax";

function browserNonce(cookie: string | undefined): string | undefined {
  const entries = (cookie ?? "").split(";").map((part) => part.trim());
  const hits = entries.filter((part) => part.startsWith(`${BROWSER_COOKIE}=`));
  if (hits.length !== 1) return undefined;
  const value = hits[0]?.slice(BROWSER_COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

/** The employee portal uses a separate access token for its own control-plane resource. */
export function connectionControlAuth(
  inbound: InboundAuthConfig,
  profile: IdentityProfile,
  redirectUri: string,
  env: NodeJS.ProcessEnv,
) {
  const audience = enterpriseOAuthControlAudience(redirectUri);
  const authentication = {
    ...profile.authentication,
    audience,
    resource: audience,
    requiredScopes: [ENTERPRISE_OAUTH_CONTROL_SCOPE],
    ...(profile.authentication.introspection && {
      introspection: {
        ...profile.authentication.introspection,
        audienceSource: "response" as const,
      },
    }),
  };
  return {
    ...inbound,
    resource: audience,
    audience,
    requiredScopes: authentication.requiredScopes,
    identityProfile: { ...profile, authentication },
    ...(authentication.provider === "oauth2_introspection" && {
      introspect: createTokenIntrospector(authentication, env),
    }),
  };
}

export function createEnterpriseConnect(
  air: AirDocument,
  inbound: InboundAuthConfig,
  baseUrl: string,
  environment: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const profile = inbound.identityProfile;
  const binding = loadEnterpriseOAuthBinding(env, air, profile, baseUrl);
  if (!binding) return undefined;
  if (!profile) throw new Error("Enterprise OAuth requires an employee identity profile.");
  if (environment !== "dev" && env.ANVIL_VAULT_BACKEND?.trim() !== "firestore")
    throw new Error("Enterprise OAuth outside dev requires a Firestore/KMS vault.");
  const clientId = env[binding.clientIdEnv];
  const clientSecret = env[binding.clientSecretEnv];
  if (!clientId?.trim() || !clientSecret?.trim())
    throw new Error("Enterprise OAuth client credentials are required.");
  const store = new EnterpriseGrantStore(
    vaultFromEnv(env),
    enterpriseOAuthNamespace(binding, profile, clientId),
  );
  const flow = new EnterpriseOAuthFlow({
    ...binding,
    client: {
      clientId,
      clientSecret,
      clientAuth: "client_secret_basic",
      tokenEndpoint: binding.tokenEndpoint,
    },
    store,
    verifyAccessToken: createEnterpriseTokenVerifier(binding, profile, env),
  });
  const auth = connectionControlAuth(inbound, profile, binding.redirectUri, env);
  return {
    audience: auth.audience,
    credentials: enterpriseCredentialResolver(binding, flow, air),
    handle: connectionHandler(flow, auth),
  };
}

type ConnectApi = Pick<EnterpriseOAuthFlow, "start" | "callback" | "disconnect" | "status">;
type ControlAuth = ReturnType<typeof connectionControlAuth>;

/** Called only for /connect/* on a deployment with a reviewed standalone binding. */
export function connectionHandler(
  flow: ConnectApi,
  auth: ControlAuth,
  verify: typeof verifyInboundToken = verifyInboundToken,
  audit: (line: string) => void = console.info,
) {
  const origin = new URL(auth.audience).origin;
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    // The callback contains a one-use authorization code. Never repeat its URL,
    // error_description, access token, or cookies in a response or audit event.
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("content-type", "application/json");
    const respond = (status: number, body: object) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    const route = url.pathname;
    const expectedMethod = {
      "/connect/callback": "GET",
      "/connect/start": "POST",
      "/connect/status": "GET",
      "/connect/disconnect": "POST",
    }[route];
    if (!expectedMethod) return respond(404, { error: "not_found" });
    if (req.method !== expectedMethod) {
      res.setHeader("allow", expectedMethod);
      return respond(405, { error: "method_not_allowed" });
    }
    let principalId: string | undefined;
    const record = (outcome: string) =>
      audit(
        JSON.stringify({
          event: "enterprise_oauth",
          route,
          outcome,
          ...(principalId && { principalId }),
        }),
      );
    try {
      if (route === "/connect/callback") {
        const nonce = browserNonce(req.headers.cookie);
        if (!nonce) return respond(400, { error: "invalid_state" });
        const params: Record<string, string> = {};
        for (const key of ["state", "code", "iss", "error"]) {
          const values = url.searchParams.getAll(key);
          if (values.length > 1) return respond(400, { error: "invalid_callback" });
          if (values[0]) params[key] = values[0];
        }
        principalId = await flow.callback(params, nonce);
        res.setHeader("set-cookie", `${BROWSER_COOKIE}=; Max-Age=0${COOKIE_ATTRIBUTES}`);
        record("connected");
        return respond(200, { status: "connected" });
      }

      // The portal forwards the browser origin and authenticates its employee
      // separately. Never trust cookies, origin alone or the platform ID token.
      if (
        (req.method === "POST" || req.headers.origin !== undefined) &&
        req.headers.origin !== origin
      )
        return respond(403, { error: "invalid_origin" });
      const token = req.headers.authorization;
      const verified = await verify(token, auth);
      if (!verified.ok) {
        res.setHeader("www-authenticate", verified.wwwAuthenticate);
        return respond(verified.status, { error: verified.error });
      }
      const audiences = verified.claims.aud;
      const single =
        typeof audiences === "string"
          ? audiences
          : audiences?.length === 1
            ? audiences[0]
            : undefined;
      if (single !== auth.audience) return respond(403, { error: "invalid_audience" });
      const principal = mapIdentity(
        auth.identityProfile,
        inboundIdentityFrom(token?.replace(/^Bearer +/i, "").trim(), verified.claims, auth),
      );
      if (!principal) return respond(403, { error: "invalid_principal" });
      principalId = principal.id;
      if (route === "/connect/start") {
        const nonce = randomBytes(32).toString("base64url");
        const result = await flow.start(principal, nonce);
        res.setHeader("set-cookie", `${BROWSER_COOKIE}=${nonce}; Max-Age=600${COOKIE_ATTRIBUTES}`);
        record("started");
        return respond(200, result);
      }
      if (route === "/connect/disconnect") {
        const disconnected = await flow.disconnect(principal);
        record("disconnected");
        return respond(200, { disconnected });
      }
      return respond(200, { status: await flow.status(principal) });
    } catch (error) {
      const code = error instanceof EnterpriseOAuthError ? error.code : "dependency_unavailable";
      record(code);
      return respond(error instanceof EnterpriseOAuthError ? error.status : 503, { error: code });
    }
  };
}
