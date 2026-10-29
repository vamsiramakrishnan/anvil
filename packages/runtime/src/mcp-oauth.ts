import { randomBytes } from "node:crypto";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { isSendableOAuthEndpoint } from "./oauth-endpoint.js";
import { type ConnectionVault, CredentialUnavailableError } from "./vault.js";

/** Reviewed resource and pre-registered OAuth client, supplied only by the deployer. */
export interface McpOAuthConfig {
  resource: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** Additional deployer-reviewed origins for authorization/token endpoints. */
  allowedOrigins?: string[];
}

export interface McpAccount {
  sub: string;
  connector: string;
  account: string;
}

/** Reject unreviewed origins and redirects before handing a server any credential. */
export function mcpOAuthFetch(config: McpOAuthConfig, fetchImpl: typeof fetch): typeof fetch {
  const origins = new Set([
    new URL(config.resource).origin,
    new URL(config.issuer).origin,
    ...(config.allowedOrigins ?? []),
  ]);
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const parsed = new URL(url);
    if (
      !isSendableOAuthEndpoint(url) ||
      parsed.username ||
      parsed.password ||
      !origins.has(parsed.origin)
    )
      throw new Error("OAuth endpoint is outside the reviewed origins.");
    return fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
  };
}

/** SDK OAuth provider whose tokens belong to one owner/account/resource in the encrypted vault. */
export class VaultMcpOAuth implements OAuthClientProvider {
  readonly stateValue = randomBytes(32).toString("base64url");
  authorizationUrl: string | undefined;
  private verifier: string | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly vault: ConnectionVault,
    readonly account: McpAccount,
    readonly config: McpOAuthConfig,
    readonly redirectUrl: string,
    private readonly interactive: boolean,
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.fetchImpl = mcpOAuthFetch(config, fetchImpl);
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_basic" : "none",
      scope: this.config.scopes.join(" "),
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed {
    return {
      client_id: this.config.clientId,
      ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
      issuer: this.config.issuer,
    };
  }

  private connection() {
    const current = this.vault.get(this.account.sub, this.account.connector, this.account.account);
    if (!current) return undefined;
    if (
      current.status !== "active" ||
      current.mcp?.resource !== this.config.resource ||
      current.mcp.issuer !== this.config.issuer
    )
      throw this.unavailable();
    return current;
  }

  tokens(): OAuthTokens | undefined {
    // Starting human consent must not silently refresh an existing account instead.
    if (this.interactive) return undefined;
    const current = this.connection();
    return current?.mcp ? OAuthTokensSchema.parse(current.mcp.tokens) : undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    if (tokens.issuer !== this.config.issuer || tokens.token_type.toLowerCase() !== "bearer") {
      throw this.unavailable();
    }
    const old = this.vault.get(this.account.sub, this.account.connector, this.account.account);
    const sameResource =
      old?.mcp?.resource === this.config.resource && old.mcp.issuer === this.config.issuer;
    const previous = sameResource && old.status === "active" ? old.mcp?.tokens : undefined;
    if (
      tokens.scope
        ?.split(/\s+/)
        .filter(Boolean)
        .some((scope) => !this.config.scopes.includes(scope))
    ) {
      throw this.unavailable();
    }
    const stamp = new Date(this.now()).toISOString();
    this.vault.put({
      sub: this.account.sub,
      connector: this.account.connector,
      account: this.account.account,
      kind: "oauth",
      status: "active",
      createdAt: old?.createdAt ?? stamp,
      updatedAt: stamp,
      ...(tokens.expires_in !== undefined
        ? { expiresAt: this.now() + tokens.expires_in * 1000 }
        : {}),
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
      mcp: {
        resource: this.config.resource,
        issuer: this.config.issuer,
        tokens: { ...tokens, refresh_token: tokens.refresh_token ?? previous?.refresh_token },
      },
    });
  }

  redirectToAuthorization(url: URL): void {
    if (
      !this.interactive ||
      !this.authorizationOriginAllowed(url.origin) ||
      url.searchParams.get("resource") !== this.config.resource
    )
      throw this.unavailable();
    const requested = url.searchParams.get("scope")?.split(/\s+/).filter(Boolean) ?? [];
    if (requested.some((scope) => !this.config.scopes.includes(scope))) throw this.unavailable();
    this.authorizationUrl = url.toString();
  }

  saveCodeVerifier(value: string): void {
    this.verifier = value;
  }
  codeVerifier(): string {
    if (!this.verifier) throw this.unavailable();
    return this.verifier;
  }

  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL> {
    if (String(serverUrl) !== this.config.resource || resource !== this.config.resource) {
      throw this.unavailable();
    }
    return new URL(this.config.resource);
  }

  saveDiscoveryState(value: OAuthDiscoveryState): void {
    const metadata = value.authorizationServerMetadata;
    if (
      value.authorizationServerUrl !== this.config.issuer ||
      metadata?.issuer !== this.config.issuer ||
      value.resourceMetadata?.resource !== this.config.resource
    )
      throw this.unavailable();
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint]) {
      if (
        !endpoint ||
        !isSendableOAuthEndpoint(endpoint) ||
        !this.authorizationOriginAllowed(new URL(endpoint).origin)
      )
        throw this.unavailable();
    }
    this.discovery = value;
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "discovery") {
      this.discovery = undefined;
      return;
    }
    if (scope === "verifier") {
      this.verifier = undefined;
      return;
    }
    const current = this.vault.get(this.account.sub, this.account.connector, this.account.account);
    if (current) this.vault.put({ ...current, status: "needs_reconnect" });
    throw this.unavailable();
  }

  private authorizationOriginAllowed(origin: string): boolean {
    return (
      origin === new URL(this.config.issuer).origin ||
      this.config.allowedOrigins?.includes(origin) === true
    );
  }

  private unavailable(): CredentialUnavailableError {
    return new CredentialUnavailableError(
      "This upstream MCP account requires human connection or renewed consent.",
      {
        code: "connector/needs_reconnect",
        connector: this.account.connector,
        account: this.account.account,
      },
    );
  }

  async authorize(code?: string): Promise<"AUTHORIZED" | "REDIRECT"> {
    try {
      return await auth(this, {
        serverUrl: this.config.resource,
        authorizationCode: code,
        scope: this.config.scopes.join(" "),
        fetchFn: this.fetchImpl,
      });
    } catch {
      throw this.unavailable();
    }
  }

  /** Refresh proactively, with rotating refresh tokens serialized by the existing vault lock. */
  async ready(): Promise<void> {
    await this.vault.withLock(
      this.account.sub,
      this.account.connector,
      this.account.account,
      async () => {
        const current = this.connection();
        if (!current?.mcp) throw this.unavailable();
        if (current.expiresAt !== undefined && current.expiresAt <= this.now() + 60_000) {
          if (!current.mcp.tokens.refresh_token || (await this.authorize()) !== "AUTHORIZED") {
            throw this.unavailable();
          }
        }
      },
    );
  }
}
