/**
 * The rules that decide whether an estate import may proceed, as pure functions
 * over the requested options.
 *
 * These are domain rules, not CLI concerns — "`--attest-spec-override` is defined
 * only for WSO2 native Definitions lineage" is a statement about gateway lineage
 * that happens to be reachable through a flag. In `estate.ts` each one was
 * expressed as *emit a message and return 1*, which meant it could only be
 * exercised by driving the CLI, and could not be consulted by any other surface.
 *
 * Each rule returns a rejection or `undefined`. Rendering stays at the delivery
 * boundary, and so does the *order* in which the rules are consulted: which error
 * a caller sees when two things are wrong at once is observable behaviour, so the
 * caller keeps invoking these exactly where the inline checks used to run.
 */

/**
 * A refusal, as data.
 *
 * `code` is optional because two of these rules have never carried one — they
 * are emitted as a bare message on stderr with no machine-readable envelope.
 * That is preserved rather than tidied: the codes are a contract, and inventing
 * one here would be a silent addition to it. Recorded as a finding instead.
 */
export interface EstateImportRejection {
  code?: string;
  message: string;
}

/** Exactly the options these rules read. Not the whole CLI option bag. */
export interface ImportPolicyInput {
  vendor: string;
  spec?: string;
  attestSpecOverride?: string;
  gatewayUrl?: string;
  gatewayId?: string;
  strictIdentity?: boolean;
}

/** The longest attestation reason a receipt will carry. */
const MAX_SPEC_OVERRIDE_REASON_CHARS = 2_000;

/**
 * Attesting a supplied contract over the gateway's own definition is a claim
 * about lineage, so it needs a contract to attest, a vendor whose native lineage
 * is modelled, and a reason a reviewer can read.
 */
export function specOverrideRejection(opts: ImportPolicyInput): EstateImportRejection | undefined {
  if (opts.attestSpecOverride === undefined) return undefined;
  if (!opts.spec) {
    return {
      code: "gateway/spec_override_without_spec",
      message:
        "`--attest-spec-override` requires `--spec`; there is no supplied contract to attest.",
    };
  }
  if (opts.vendor !== "wso2") {
    return {
      code: "gateway/spec_override_wrong_vendor",
      message:
        "`--attest-spec-override` is currently defined only for WSO2 native Definitions lineage.",
    };
  }
  const reason = opts.attestSpecOverride.trim();
  if (!reason || reason.length > MAX_SPEC_OVERRIDE_REASON_CHARS) {
    return {
      code: "gateway/invalid_spec_override_attestation",
      message: `\`--attest-spec-override <reason>\` requires a non-empty reason of at most ${MAX_SPEC_OVERRIDE_REASON_CHARS.toLocaleString("en-US")} characters.`,
    };
  }
  return undefined;
}

/** The attestation reason a valid `--attest-spec-override` carries. */
export function specOverrideReason(opts: ImportPolicyInput): string | undefined {
  return opts.attestSpecOverride?.trim();
}

/**
 * A contract's own `servers` entry is not proof that calls still traverse the
 * imported gateway, so supplying one requires naming the gateway explicitly.
 */
export function suppliedContractRejection(
  opts: ImportPolicyInput,
): EstateImportRejection | undefined {
  if (opts.spec && !opts.gatewayUrl) {
    return {
      message:
        "`--gateway-url <https://gateway.example/base>` is required with `--spec`; Anvil will not trust a contract's server as proof that calls still traverse the imported gateway.",
    };
  }
  return undefined;
}

/**
 * The public gateway URL must be an absolute HTTPS origin with no credentials,
 * query, or fragment — it is recorded into the receipt as the runtime coordinate.
 */
function normalizeGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid --gateway-url '${value}': expected an absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Invalid --gateway-url '${value}': the public gateway URL must use HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`Invalid --gateway-url '${value}': embedded credentials are not allowed.`);
  }
  if (url.search || url.hash) {
    throw new Error(
      `Invalid --gateway-url '${value}': query strings and fragments are not allowed.`,
    );
  }
  url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  return url.toString();
}

/** The normalized gateway URL, or the refusal explaining why it is not usable. */
export function resolveGatewayUrl(
  opts: ImportPolicyInput,
): { url?: string } | { rejection: EstateImportRejection } {
  if (!opts.gatewayUrl) return {};
  try {
    return { url: normalizeGatewayUrl(opts.gatewayUrl) };
  } catch (err) {
    return { rejection: { message: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * `unscoped` is reserved for compatibility lineage whose gateway identity was
 * never proven, so it can never be supplied as a real one.
 */
export function invalidGatewayId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) {
    return "Invalid --gateway-id: expected a non-empty stable control-plane/org/instance id.";
  }
  if (normalized.toLowerCase() === "unscoped") {
    return "Invalid --gateway-id: 'unscoped' is reserved for compatibility lineage whose gateway identity is not proven; provide the real stable control-plane/org/instance id.";
  }
  return undefined;
}

/**
 * An offline export cannot prove its own control-plane identity, so strict
 * identity has to be told what that identity is.
 */
export function gatewayIdentityRejection(
  opts: ImportPolicyInput,
): EstateImportRejection | undefined {
  const invalid = invalidGatewayId(opts.gatewayId);
  if (invalid) {
    return { code: "gateway_selection/invalid_gateway_id", message: invalid };
  }
  if (opts.strictIdentity && !opts.gatewayId?.trim()) {
    return {
      code: "gateway_selection/gateway_id_required",
      message:
        "`--strict-identity` requires `--gateway-id <id>` because this offline export does not prove its control-plane identity.",
    };
  }
  return undefined;
}
