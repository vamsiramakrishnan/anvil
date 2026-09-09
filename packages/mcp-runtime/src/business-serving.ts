import { readFileSync } from "node:fs";
import { type AirDocument, hashCanonical, loadBusinessPlan } from "@anvil/air";
import {
  allowedHostsFor,
  type BusinessApproval,
  type BusinessContext,
  type BusinessHost,
  BusinessTransport,
  type ExecuteContext,
  type InboundIdentity,
} from "@anvil/runtime";

interface SourceConfig {
  baseUrl?: string;
  authProfile?: string;
  scopes?: string[];
}

/** Operator configuration and verified inbound identity are the only context sources. */
export function createBusinessServing(
  air: AirDocument,
  rawPlan: unknown,
  base: ExecuteContext,
  env: NodeJS.ProcessEnv = process.env,
) {
  const plan = loadBusinessPlan(rawPlan, air.business?.planDigest);
  const sources = JSON.parse(env.ANVIL_BUSINESS_SOURCES ?? "{}") as Record<string, SourceConfig>;
  for (const [name, config] of Object.entries(sources)) {
    if (!Object.hasOwn(plan.sources, name)) throw new Error(`Unknown business source ${name}.`);
    if (
      config.baseUrl !== undefined &&
      !["http:", "https:"].includes(new URL(config.baseUrl).protocol)
    )
      throw new Error("Business sources need HTTP(S) URLs.");
    if (config.authProfile !== undefined && typeof config.authProfile !== "string")
      throw new Error("Invalid business source auth profile.");
    if (
      config.scopes !== undefined &&
      (!Array.isArray(config.scopes) || config.scopes.some((s) => typeof s !== "string"))
    )
      throw new Error("Invalid business source grants.");
  }
  function contextFor(identity?: InboundIdentity): BusinessContext {
    const executionBinding = hashCanonical({
      environment: base.env,
      sources: Object.fromEntries(
        Object.entries(plan.sources).map(([name, source]) => [
          name,
          {
            baseUrl: sources[name]?.baseUrl ?? source.service.servers[0]?.url,
            authProfile: sources[name]?.authProfile ?? name,
            scopes: [...(sources[name]?.scopes ?? [])].sort(),
          },
        ]),
      ),
    });
    if (!identity && base.env === "dev" && env.ANVIL_BUSINESS_CONTEXT) {
      const context = JSON.parse(env.ANVIL_BUSINESS_CONTEXT) as BusinessContext;
      if (!Array.isArray(context.scopes) || context.scopes.some((s) => typeof s !== "string"))
        throw new Error("Invalid development business context.");
      return { ...context, executionBinding };
    }
    const claims = identity?.claims ?? {};
    const issuer = typeof claims.iss === "string" ? claims.iss : "";
    const subject = identity?.sub ?? "";
    const tenant = claims.tid ?? claims.tenant ?? env.ANVIL_BUSINESS_TENANT;
    return {
      tenant: typeof tenant === "string" ? tenant : "",
      principal: issuer && subject ? `${issuer}:${subject}` : "",
      policyVersion: env.ANVIL_BUSINESS_POLICY_VERSION ?? "",
      executionBinding,
      scopes: (identity?.scope ?? "").split(/\s+/).filter(Boolean),
    };
  }
  function hostFor(identity?: InboundIdentity): BusinessHost {
    const context = contextFor(identity);
    return {
      context,
      env: base.env === "dev" ? "dev" : "prod",
      ledger: base.ledger,
      contextFor: (name, source) => {
        const config = sources[name];
        const baseUrl = config?.baseUrl ?? source.service.servers[0]?.url ?? "";
        return {
          ...base,
          serviceId: source.service.id,
          baseUrl,
          remoteIdempotency: false,
          authProfile: config?.authProfile ?? name,
          allowedHosts: allowedHostsFor([], baseUrl, true),
          inbound: identity,
          principal: { id: context.principal, scopes: config?.scopes ?? [] },
        };
      },
      approvalFor: async (digest) => {
        if (!env.ANVIL_BUSINESS_APPROVAL_FILE) return undefined;
        const text = readFileSync(env.ANVIL_BUSINESS_APPROVAL_FILE, "utf8");
        if (Buffer.byteLength(text) > 1_048_576)
          throw new Error("Approval store exceeds its size limit.");
        const records = JSON.parse(text) as BusinessApproval[];
        if (!Array.isArray(records)) return undefined;
        return records.find((record) => record.digest === digest);
      },
    };
  }
  return {
    transportFor: (identity?: InboundIdentity) => new BusinessTransport(plan, hostFor(identity)),
    mcpContext: (identity?: InboundIdentity): Partial<ExecuteContext> => ({
      transport: new BusinessTransport(plan, hostFor(identity)),
      remoteIdempotency: true,
      // No network auth on this in-process hop. hostFor still requires verified caller context.
      credentials: { resolve: async () => ({}) },
      principal: { id: contextFor(identity).principal, scopes: contextFor(identity).scopes },
    }),
  };
}
