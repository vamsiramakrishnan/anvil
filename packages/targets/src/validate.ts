/**
 * Validate a contract against a target profile. Findings are data. The checks that
 * matter for a self-enforcing custom MCP: transport/HTTPS, action budget, action
 * descriptions, OAuth coverage, and — the safety one — that irreversible mutations
 * confirm *in the contract*, because the platform will not confirm for you.
 */
import type { AirDocument } from "@anvil/air";
import type {
  AgentPlatformTargetProfile,
  TargetValidationFinding,
  TargetValidationResult,
} from "./model.js";

export interface ValidateTargetOptions {
  /** The deployed endpoint, when known — enables transport/HTTPS checks. */
  endpoint?: string;
}

export function validateTarget(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  options: ValidateTargetOptions = {},
): TargetValidationResult {
  const findings: TargetValidationFinding[] = [];
  const served = air.operations.filter((o) => o.state === "approved");

  // Transport / HTTPS.
  const needsHttps = profile.transportRequirements.some((t) => t.requiresHttps);
  if (options.endpoint && needsHttps && !options.endpoint.startsWith("https://")) {
    findings.push({
      level: "error",
      code: "target/insecure_transport",
      message: `${profile.displayName} requires an HTTPS endpoint; got ${options.endpoint}.`,
    });
  }

  // Action-selection budget.
  if (served.length > profile.actionLimits.maxActions) {
    findings.push({
      level: "error",
      code: "target/action_budget_exceeded",
      message: `${served.length} actions exceed the ${profile.actionLimits.maxActions}-action budget; split the capability.`,
    });
  }
  if (profile.actionLimits.requiresActionDescriptions) {
    const undescribed = served
      .filter((o) => o.description.trim().length === 0)
      .map((o) => o.mcp.toolName);
    if (undescribed.length > 0) {
      findings.push({
        level: "warning",
        code: "target/missing_action_descriptions",
        message: `Actions need descriptions for selection: ${undescribed.join(", ")}.`,
      });
    }
  }

  // OAuth coverage: if the platform configures OAuth but nothing in the contract
  // requires auth, the server may be unintentionally open.
  const requiresOauth = profile.authRequirements.some((a) => a.kind === "oauth2");
  const contractHasAuth = served.some((o) => o.auth.type !== "none");
  if (requiresOauth && served.length > 0 && !contractHasAuth) {
    findings.push({
      level: "warning",
      code: "target/no_auth_in_contract",
      message:
        "The target configures OAuth but no operation declares auth — confirm the server is not open.",
    });
  }

  // Safety self-enforcement: an irreversible/high-risk mutation must confirm in the
  // contract, because the platform does not confirm for you.
  const unconfirmed = served.filter(
    (o) =>
      o.effect.kind === "mutation" &&
      (o.effect.reversible === false ||
        o.effect.risk === "financial" ||
        o.effect.risk === "destructive") &&
      !o.confirmation.required,
  );
  for (const op of unconfirmed) {
    findings.push({
      level: "error",
      code: "target/unconfirmed_irreversible_action",
      message: `${op.mcp.toolName} is an irreversible ${op.effect.risk} mutation but does not confirm; the platform will not confirm for you.`,
    });
  }

  return { ok: !findings.some((f) => f.level === "error"), findings };
}
