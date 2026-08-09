/**
 * The long-running contract: what an agent does with a call that returns before
 * the work is finished.
 *
 * AIR already carries a `longRunning` flag and a `long_running` archetype, and
 * the MCP tool description already tells an agent to "poll for status". None of
 * that says *what to poll*, *what to poll it with*, or *how to know it stopped*.
 * An agent handed a 202 and that sentence is exactly as stuck as one handed a
 * 202 and nothing — it has been told a problem exists, not how to finish the job.
 *
 * This is the missing linkage, and it is deliberately all-or-nothing. A contract
 * that names a status operation without saying which field carries the handle,
 * or that lists no terminal state, leaves the agent polling forever or calling
 * with a value it invented. Half a contract here is worse than none, because
 * none at least fails visibly. So `asyncContractIssue` rejects a partial
 * contract rather than serving it, in the same spirit as `safePageSize`
 * reporting `unmeasured` instead of guessing a page size.
 */
import type { Operation } from "./schema.js";

/**
 * How an agent completes a call that returns before its work does.
 *
 * Every field is a *coordinate the runtime can actually use*, not prose: an id
 * to look up, a field to read a handle from, a parameter to put it in. Anything
 * an agent would have to interpret rather than follow does not belong here.
 */
export interface AsyncContract {
  /**
   * The operation an agent polls. Must resolve to a real, approved read — a
   * contract pointing at an unapproved or missing operation sends the agent into
   * a loop against a call it cannot make, which is the specific failure this
   * whole shape exists to prevent.
   *
   * Absent for webhook-only APIs — some providers expose no poll endpoint at
   * all, only a push. `resolveAsyncContract` requires at least one of
   * `statusOperationId` or `webhook` to be present; requiring a status
   * operation unconditionally would make a genuinely webhook-only API
   * unrepresentable.
   */
  statusOperationId?: string;
  /**
   * Dotted path into *this* operation's response carrying the job handle, e.g.
   * `job.id`. Read once, then passed to the status operation.
   */
  jobIdField: string;
  /** The parameter on the status operation that accepts that handle. Required only alongside `statusOperationId` — there's no param to fill when there's no poll call. */
  statusJobIdParam?: string;
  /** Dotted path into the *status* response carrying the current state. */
  stateField?: string;
  /**
   * States that mean "stop polling" — successes and failures alike. Without at
   * least one, an agent has no stopping condition and will poll until something
   * else kills it, so a contract with none is treated as unusable.
   */
  terminalStates: string[];
  /**
   * States that mean "still working". Advisory; absence is not an error.
   * Recognizes `"awaiting_human_input"` for operations whose upstream itself
   * tracks a pending-approval state (§8) — `anvil job answer` calls a real
   * upstream decision operation, it does not resume anything Anvil paused.
   */
  pendingStates: string[];
  /**
   * Server-stated polling interval in seconds. Only ever recorded when the
   * contract says it — never inferred, because a guessed interval is either a
   * self-inflicted rate limit or a stampede.
   */
  pollIntervalSeconds?: number;
  /** Optional. Absent = pure poll, byte-identical to before this field existed. */
  webhook?: WebhookContract;
}

/**
 * How an agent completes a call via a push notification instead of a poll.
 *
 * Every field is a coordinate the runtime can use, matching `AsyncContract`'s
 * own discipline: an operation id to look up, a field to read a handle from,
 * a scheme to verify a sender with. `signatureVerification` is required —
 * there is no "none" variant, because an unverified webhook payload can be
 * forged by anyone who finds the receiver URL.
 */
export interface WebhookContract {
  /** The inbound operation compiled from the spec's callbacks:/webhooks: entry. */
  webhookOperationId: string;
  /** Dotted path into the webhook payload carrying the job handle. */
  webhookJobIdField: string;
  /** Dotted path into the webhook payload carrying terminal/pending state, if any. */
  webhookStateField?: string;
  /** How the receiver verifies the sender before trusting the payload. */
  signatureVerification: WebhookSignatureVerification;
}

/**
 * Four real shapes, grounded in vendor deep dives (Stripe, GitHub, Twilio,
 * PayPal, GCP Pub/Sub) — a single "hmac over the raw body" scheme would
 * silently misclassify most of them.
 */
export type WebhookSignatureVerification =
  | {
      /** Raw-body HMAC, digest carried in one header. Fits GitHub, Shopify. */
      scheme: "hmac_sha256_header";
      headerName: string;
      encoding: "hex" | "base64";
      /** Optional literal prefix to strip before comparing, e.g. GitHub's "sha256=". */
      valuePrefix?: string;
      secretRef: string;
    }
  | {
      /**
       * Non-standard vendor logic a generic HMAC scheme can't express —
       * composite/timestamped headers (Stripe), signed-material-other-than-
       * the-body (Twilio).
       */
      scheme: "provider_sdk";
      provider: "stripe" | "twilio" | "github" | "shopify";
      secretRef: string;
    }
  | {
      /**
       * Verification requires an outbound call to the provider's own verify
       * endpoint (PayPal-shaped). Has its own egress implication — see
       * `RuntimeConfig.allowedHosts`.
       */
      scheme: "remote_verify";
      provider: "paypal";
      verifyEndpointRef: string;
      credentialRef: string;
    }
  | {
      /**
       * Signed JWT bearer in a header, verified against the issuer's public
       * keys — GCP Pub/Sub push subscriptions use this shape, not HMAC.
       */
      scheme: "oidc_jwt";
      headerName: string;
      expectedIssuer: string;
      expectedAudienceRef: string;
    };

/** Why an async contract cannot be honored, in the runtime's own terms. */
export type AsyncContractIssue =
  | "no_contract"
  | "status_operation_missing"
  | "status_operation_not_approved"
  | "status_operation_is_mutation"
  | "status_param_missing"
  /** The handle path is provably absent from the submit operation's response. */
  | "job_id_field_absent"
  /** The state path is provably absent from the status operation's response. */
  | "state_field_absent"
  /** A state means both "stop" and "keep going". */
  | "overlapping_states"
  | "no_terminal_states"
  /** Neither `statusOperationId` nor `webhook` is present — no way to complete. */
  | "no_completion_source"
  | "webhook_operation_missing"
  /** The handle path is provably absent from the webhook operation's input schema. */
  | "webhook_job_id_field_absent"
  /** A ref field (secretRef/verifyEndpointRef/credentialRef/...) the scheme needs is blank. */
  | "webhook_signature_unverifiable";

/**
 * Whether a dotted path is *provably* absent from a modeled JSON Schema.
 *
 * Deliberately timid, and the asymmetry is the whole point: returning `true`
 * refuses a contract, so it may only be said when the schema actually enumerates
 * what it contains. A schema with no `properties`, or one that permits
 * `additionalProperties`, is not evidence of absence — it is a schema that
 * declined to answer, and refusing on that would reject every honest contract
 * built over a loosely-typed response.
 */
function pathProvablyAbsent(schema: unknown, dottedPath: string): boolean {
  const segments = dottedPath.split(".").filter(Boolean);
  if (segments.length === 0) return false;

  let node: unknown = schema;
  for (const segment of segments) {
    if (typeof node !== "object" || node === null) return false;
    const record = node as Record<string, unknown>;
    // An array in the path means the next segment addresses the item shape.
    const unwrapped =
      record.type === "array" && typeof record.items === "object" && record.items !== null
        ? (record.items as Record<string, unknown>)
        : record;
    const properties = unwrapped.properties;
    if (typeof properties !== "object" || properties === null) return false;
    // An open schema can always carry the field without declaring it.
    if (unwrapped.additionalProperties !== false && unwrapped.additionalProperties !== undefined) {
      return false;
    }
    const next = (properties as Record<string, unknown>)[segment];
    if (next === undefined) return true;
    node = next;
  }
  return false;
}

export type AsyncContractResolution =
  | {
      ok: true;
      contract: AsyncContract;
      /** Absent for a webhook-only contract — there is no poll operation. */
      statusOperation?: Operation;
      /** Present only when `contract.webhook` resolved. */
      webhookOperation?: Operation;
    }
  | { ok: false; issue: AsyncContractIssue; detail: string };

/**
 * Whether a webhook signature scheme carries the reference fields it needs to
 * verify a sender. Deliberately structural, not a real secret-store lookup —
 * that happens at certification/deploy time (§13's `allowedHosts` and
 * signature-scheme-resolvable checks). A blank ref here is a half-stated
 * contract, and half a contract is worse than none.
 */
function webhookSignatureVerifiable(verification: WebhookSignatureVerification): boolean {
  const nonBlank = (value: string) => value.trim().length > 0;
  switch (verification.scheme) {
    case "hmac_sha256_header":
    case "provider_sdk":
      return nonBlank(verification.secretRef);
    case "remote_verify":
      return nonBlank(verification.verifyEndpointRef) && nonBlank(verification.credentialRef);
    case "oidc_jwt":
      return nonBlank(verification.expectedIssuer) && nonBlank(verification.expectedAudienceRef);
  }
}

/**
 * Resolve an operation's async contract against the document it lives in.
 *
 * Shared by the compiler (which refuses to emit an unusable contract), the
 * certification pass (which refuses to certify one), and any serving path that
 * wants to describe polling to an agent — so all three agree on what "usable"
 * means rather than each deciding for itself.
 *
 * Pure: same operation and same operation set always yield the same resolution.
 */
export function resolveAsyncContract(
  operation: Operation,
  operationsById: ReadonlyMap<string, Operation>,
): AsyncContractResolution {
  const contract = operation.asyncContract;
  if (!contract) return { ok: false, issue: "no_contract", detail: operation.id };

  // At least one way to find out the job finished. Requiring a status
  // operation unconditionally would make a genuinely webhook-only API
  // unrepresentable.
  if (!contract.statusOperationId && !contract.webhook) {
    return {
      ok: false,
      issue: "no_completion_source",
      detail: `${operation.id} declares neither a status operation nor a webhook to complete on`,
    };
  }

  let status: Operation | undefined;
  if (contract.statusOperationId) {
    status = operationsById.get(contract.statusOperationId);
    if (!status) {
      return {
        ok: false,
        issue: "status_operation_missing",
        detail: `${operation.id} polls '${contract.statusOperationId}', which does not exist`,
      };
    }

    // A status call that mutates is not a status call. Polling repeats by
    // definition, so anything with an effect would be applied over and over —
    // the one shape that turns a safe wait into an unbounded write.
    if (status.effect.kind !== "read") {
      return {
        ok: false,
        issue: "status_operation_is_mutation",
        detail: `${operation.id} polls '${status.id}', which is a mutation`,
      };
    }

    // Approval is checked here rather than left to the serving path because the
    // failure is silent for the agent: it follows the contract, calls a tool that
    // was never exposed, and cannot tell "not approved" from "job not ready".
    if (status.state !== "approved") {
      return {
        ok: false,
        issue: "status_operation_not_approved",
        detail: `${operation.id} polls '${status.id}', which is ${status.state}`,
      };
    }

    const hasParam = status.input.params.some((param) => param.name === contract.statusJobIdParam);
    if (!hasParam) {
      return {
        ok: false,
        issue: "status_param_missing",
        detail: `'${status.id}' has no parameter '${contract.statusJobIdParam}' to carry the job handle`,
      };
    }
  }

  let webhookOperation: Operation | undefined;
  if (contract.webhook) {
    const webhook = contract.webhook;
    webhookOperation = operationsById.get(webhook.webhookOperationId);
    if (!webhookOperation) {
      return {
        ok: false,
        issue: "webhook_operation_missing",
        detail: `${operation.id} expects webhook '${webhook.webhookOperationId}', which does not exist`,
      };
    }

    if (pathProvablyAbsent(webhookOperation.input.schema, webhook.webhookJobIdField)) {
      return {
        ok: false,
        issue: "webhook_job_id_field_absent",
        detail: `'${webhook.webhookJobIdField}' is not a field of ${webhookOperation.id}'s input`,
      };
    }

    if (!webhookSignatureVerifiable(webhook.signatureVerification)) {
      return {
        ok: false,
        issue: "webhook_signature_unverifiable",
        detail: `${operation.id}'s webhook signature scheme '${webhook.signatureVerification.scheme}' is missing a required reference`,
      };
    }
  }

  // The handle and state paths used to be accepted as arbitrary strings while
  // only `statusJobIdParam` was checked against something real. That asymmetry
  // was the bug: a contract naming `job.identifier` over a response carrying
  // `job.id` resolved cleanly, certified, and served an agent a path that reads
  // `undefined` on every poll — the silent loop this shape exists to prevent,
  // reached through the one coordinate nobody validated.
  if (pathProvablyAbsent(operation.output.schema, contract.jobIdField)) {
    return {
      ok: false,
      issue: "job_id_field_absent",
      detail: `'${contract.jobIdField}' is not a field of ${operation.id}'s response`,
    };
  }
  if (status && contract.stateField && pathProvablyAbsent(status.output.schema, contract.stateField)) {
    return {
      ok: false,
      issue: "state_field_absent",
      detail: `'${contract.stateField}' is not a field of ${status.id}'s response`,
    };
  }

  // A state in both lists means one response says "stop" and "keep going" at
  // once, and which wins depends on the order a client happens to read them in.
  // That is a coin flip between halting early and never halting.
  const overlap = contract.terminalStates.filter((state) => contract.pendingStates.includes(state));
  if (overlap.length > 0) {
    return {
      ok: false,
      issue: "overlapping_states",
      detail: `${operation.id} lists ${overlap.join(", ")} as both terminal and pending`,
    };
  }

  if (contract.terminalStates.length === 0) {
    return {
      ok: false,
      issue: "no_terminal_states",
      detail: `${operation.id} declares no terminal state, so an agent has no stopping condition`,
    };
  }

  return { ok: true, contract, statusOperation: status, webhookOperation };
}

/**
 * The agent-facing sentence for a resolved contract. Deliberately mechanical —
 * it names coordinates, not intentions, so an agent follows it rather than
 * interpreting it.
 */
export function asyncContractSentence(resolution: AsyncContractResolution): string | undefined {
  if (!resolution.ok) return undefined;
  const { contract, statusOperation } = resolution;

  if (statusOperation) {
    const parts = [
      `Returns before completion: read the job handle from '${contract.jobIdField}',`,
      `then poll '${statusOperation.mcp.toolName}' with '${contract.statusJobIdParam}'`,
    ];
    if (contract.stateField) parts.push(`and read '${contract.stateField}'`);
    parts.push(`until it reaches one of: ${contract.terminalStates.join(", ")}.`);
    if (contract.pollIntervalSeconds !== undefined) {
      parts.push(`The service asks for ${contract.pollIntervalSeconds}s between polls.`);
    }
    return parts.join(" ");
  }

  // Webhook-only: there is no poll operation to name. The generated status
  // tool is synthetic (backed only by the ledger) and reports pending until
  // the upstream calls back.
  const parts = [
    `Returns before completion: read the job handle from '${contract.jobIdField}'.`,
    "No poll operation exists for this call — the upstream completes it by calling back;",
    `check status until it reaches one of: ${contract.terminalStates.join(", ")}.`,
  ];
  return parts.join(" ");
}
