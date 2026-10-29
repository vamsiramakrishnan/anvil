import type { AuthRequirement, Operation } from "@anvil/air";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthMaterial, CredentialCallContext, CredentialResolver } from "./auth.js";
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./config.js";
import { DEFAULT_ACCOUNT } from "./grants.js";
import { type McpOAuthConfig, VaultMcpOAuth } from "./mcp-oauth.js";
import { isSendableOAuthEndpoint } from "./oauth-endpoint.js";
import { type HttpResponse, MAX_UPSTREAM_RESPONSE_BYTES, TransportError } from "./transport.js";
import { type ConnectionVault, CredentialUnavailableError } from "./vault.js";

/** A deployer-selected credential kind. Missing human credentials never select workload auth. */
export type McpConnectionConfig = { url: string } & (
  | { kind: "oauth"; oauth: McpOAuthConfig }
  | { kind: "workload" }
  | { kind: "static" }
  | { kind: "none" }
);

export interface McpBinding {
  url: string;
  toolName: string;
}
export interface PreparedMcpCall {
  send(
    input: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<HttpResponse>;
}

/** SDK sessions are owned by one call, so neither credentials nor grants survive into another caller. */
export class McpUpstream {
  constructor(
    private readonly configurations: ReadonlyMap<string, McpConnectionConfig>,
    private readonly vault: ConnectionVault,
    private readonly credentials: CredentialResolver,
    private readonly redirectUri: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  binding(op: Operation, connector?: string): McpBinding | undefined {
    const config = connector ? this.configurations.get(connector) : undefined;
    if (op.sourceRef.kind !== "mcp" || !op.sourceRef.operationId || !config) return undefined;
    return { url: config.url, toolName: op.sourceRef.operationId };
  }

  async prepare(
    binding: McpBinding,
    auth: AuthRequirement,
    profile: string,
    context: CredentialCallContext,
  ): Promise<PreparedMcpCall> {
    const connector = context.connector;
    const owner = context.principalId;
    const config = connector ? this.configurations.get(connector) : undefined;
    if (!config || !connector || !owner || config.url !== binding.url) {
      throw new CredentialUnavailableError("No configured MCP credential owner.", {
        code: "connector/unresolved",
      });
    }
    const account = context.account ?? DEFAULT_ACCOUNT;
    let material: AuthMaterial = {};
    let provider: VaultMcpOAuth | undefined;
    switch (config.kind) {
      case "oauth":
        provider = new VaultMcpOAuth(
          this.vault,
          { sub: owner, connector, account },
          config.oauth,
          this.redirectUri,
          false,
          this.fetchImpl,
          this.now,
        );
        await provider.ready();
        break;
      case "workload":
        if (auth.type !== "workload_identity") throw this.unavailable(connector, account);
        material = (await this.credentials.resolve(profile, auth, context)) ?? {};
        if (!material.headers?.Authorization) throw this.unavailable(connector, account);
        break;
      case "static":
        if (auth.type === "workload_identity" || auth.type === "none")
          throw this.unavailable(connector, account);
        material = (await this.credentials.resolve(profile, auth, context)) ?? {};
        if (!material.headers || material.query || material.tls)
          throw this.unavailable(connector, account);
        break;
      case "none":
        if (auth.type !== "none") throw this.unavailable(connector, account);
        break;
      default: {
        const exhaustive: never = config;
        return exhaustive;
      }
    }
    return {
      send: async (
        input,
        signal,
        timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
      ): Promise<HttpResponse> => {
        const deadline = AbortSignal.timeout(timeoutMs);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        let deniedStatus: 401 | 403 | undefined;
        const guardedFetch: typeof fetch = async (url, init) => {
          const target = url instanceof Request ? url.url : String(url);
          if (target !== config.url || !isSendableOAuthEndpoint(target))
            throw this.unavailable(connector, account);
          const response = await this.fetchImpl(url, {
            ...init,
            signal: bounded,
            redirect: "error",
          });
          // Never let SDK challenge handling replay an ambiguous tools/call or widen consent.
          // Expiry refresh happens before dispatch; a new challenge needs a fresh caller decision.
          if (response.status === 401 || response.status === 403) {
            deniedStatus = response.status;
            await response.body?.cancel();
            throw this.unavailable(connector, account);
          }
          if (!response.body) return response;
          let bytes = 0;
          const body = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                bytes += chunk.byteLength;
                if (bytes > MAX_UPSTREAM_RESPONSE_BYTES) {
                  throw new TransportError(
                    "connection_reset",
                    "Upstream MCP response exceeds the runtime limit.",
                    "after_response",
                  );
                }
                controller.enqueue(chunk);
              },
            }),
          );
          return new Response(body, { status: response.status, headers: response.headers });
        };
        const client = new Client({ name: "anvil-upstream", version: "0.1.0" });
        const transport = new StreamableHTTPClientTransport(new URL(config.url), {
          authProvider: provider,
          requestInit: { headers: material.headers },
          fetch: guardedFetch,
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 0,
            maxReconnectionDelay: 0,
            reconnectionDelayGrowFactor: 1,
          },
        });
        try {
          await client.connect(transport, { signal: bounded, timeout: timeoutMs });
          const result = await client.callTool(
            { name: binding.toolName, arguments: input },
            undefined,
            { signal: bounded, timeout: timeoutMs },
          );
          const body = JSON.stringify(result);
          if (Buffer.byteLength(body) > MAX_UPSTREAM_RESPONSE_BYTES) {
            throw new TransportError(
              "connection_reset",
              "Upstream MCP response exceeds the runtime limit.",
              "after_response",
            );
          }
          return {
            status: result.isError ? 502 : 200,
            headers: { "content-type": "application/json" },
            body,
          };
        } catch (error) {
          if (deniedStatus) return { status: deniedStatus, headers: {}, body: "" };
          if (error instanceof TransportError) throw error;
          throw new TransportError(
            "connection_reset",
            "Upstream MCP call failed; it was not retried.",
            "after_response",
          );
        } finally {
          await client.close().catch(() => {});
        }
      },
    };
  }

  private unavailable(connector: string, account: string): CredentialUnavailableError {
    return new CredentialUnavailableError(
      "Upstream MCP authorization is unavailable; reconnect or review the deployed auth profile.",
      {
        code: "connector/needs_reconnect",
        connector,
        account,
      },
    );
  }
}
