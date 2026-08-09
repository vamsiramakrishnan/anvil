import {
  type AirDocument,
  type AsyncContract,
  Operation,
  type WebhookSignatureVerification,
} from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeEach, describe, expect, it } from "vitest";
import { certify } from "./certify.js";
import { type CertificationDeployTarget, staticChecks } from "./checks.js";

/**
 * Certifying the long-running contract.
 *
 * The asymmetry the contract's own header states is what these tests are shaped
 * around: an operation with no contract strands an agent *visibly* — it holds a
 * job handle, has nothing to do with it, and stops. A contract that is present
 * and wrong strands it *invisibly* — it polls a tool that is not there, or one
 * that never says stop, and reports no problem while doing it. So the cases
 * below are almost all "the contract is present and wrong", and each one pins
 * both halves of the verdict: that it fails, and that the note says which
 * coordinate was wrong, in a form somebody can act on.
 *
 * The other half is the notes on the passes. Every arm here passes vacuously on
 * a document with no async contract, which is correct and completely
 * indistinguishable from real verification unless the note says which happened.
 * A report of six green ticks over a document that models nothing asynchronous
 * must not read like six verifications.
 */

const SPEC = `openapi: "3.0.3"
info: { title: Exports, version: "1.0.0" }
paths:
  /exports:
    post:
      operationId: createExport
      tags: [exports]
      responses:
        "202":
          description: accepted
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                properties:
                  job:
                    type: object
                    additionalProperties: false
                    properties:
                      id: { type: string }
  /exports/{jobId}:
    get:
      operationId: getExportStatus
      tags: [exports]
      parameters:
        - { name: jobId, in: path, required: true, schema: { type: string } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                properties:
                  state: { type: string }
`;

let air: AirDocument;

beforeEach(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "exports" });
  air = approveOperations(
    compiled,
    compiled.operations.map((operation) => operation.id),
  );
  // Start from an explicitly synchronous document. Whether the compiler detects
  // a 202 and links it is the compiler's business and its own tests'; what is
  // certified here is a contract that is *present*, however it got there — by
  // detection, by an enrichment manifest, or by hand. Resetting keeps these
  // cases from silently re-testing detection, and keeps them stable while that
  // detection is still being taught.
  for (const operation of air.operations) {
    operation.longRunning = false;
    operation.asyncContract = undefined;
  }
});

/** The compiled operation behind a source `operationId` — ids are the compiler's to mint. */
function op(doc: AirDocument, operationId: string): Operation {
  const found = doc.operations.find((entry) => entry.sourceRef.operationId === operationId);
  if (!found) throw new Error(`fixture operation ${operationId} missing`);
  return found;
}

const creator = (doc: AirDocument) => op(doc, "createExport");
const status = (doc: AirDocument) => op(doc, "getExportStatus");

/** The path param the compiler surfaced, so the fixture never invents a coordinate. */
function statusParamName(doc: AirDocument): string {
  const name = status(doc).input.params[0]?.name;
  if (!name) throw new Error("fixture status operation has no parameter");
  return name;
}

/** Wire a contract onto the creating operation, as detection will once it lands. */
function link(doc: AirDocument, over: Partial<AsyncContract> = {}): AirDocument {
  const contract: AsyncContract = {
    statusOperationId: status(doc).id,
    jobIdField: "job.id",
    statusJobIdParam: statusParamName(doc),
    stateField: "state",
    terminalStates: ["succeeded", "failed"],
    pendingStates: ["queued", "running"],
    ...over,
  };
  creator(doc).asyncContract = contract;
  creator(doc).longRunning = true;
  return doc;
}

const checkNamed = (doc: AirDocument, id: string) => {
  const found = staticChecks(doc).find((entry) => entry.id === id);
  if (!found) throw new Error(`check ${id} not emitted`);
  return found;
};

const ASYNC_CHECK_IDS = [
  "static/async_contracts_resolve",
  "static/async_status_operation_approved",
  "static/async_status_operation_is_read",
  "static/async_poll_loop_terminates",
  "static/async_contract_fields_addressable",
  "static/async_long_running_flag_coherent",
];

describe("a usable contract certifies", () => {
  it("passes every arm, and each note says what was verified", () => {
    link(air);
    for (const id of ASYNC_CHECK_IDS) {
      const entry = checkNamed(air, id);
      expect(entry, `${id}: ${entry.detail ?? ""}`).toMatchObject({ ok: true });
      // Not "1 operation(s)" alone: a reader must be able to tell that something
      // was actually resolved, not merely counted.
      expect(entry.detail).toBeTruthy();
    }
    expect(checkNamed(air, "static/async_contracts_resolve").detail).toContain(
      "resolving to an approved read with a stopping condition",
    );
    expect(checkNamed(air, "static/async_contract_fields_addressable").detail).toContain(
      "coordinate(s) located in a modeled response schema",
    );
  });

  it("certifies the document as a whole", () => {
    link(air);
    const record = certify(air);
    expect(record.checks.filter((entry) => !entry.ok)).toEqual([]);
    expect(record.status).toBe("static_passed");
  });
});

describe("a contract that would strand an agent fails", () => {
  it("refuses a poll target that does not exist, in the runtime's own vocabulary", () => {
    link(air, { statusOperationId: "exports.invented" });
    const resolves = checkNamed(air, "static/async_contracts_resolve");
    expect(resolves.ok).toBe(false);
    // The issue code is what a report groups and routes by; the prose is for the
    // human who has to fix it. Both, or the check is only half usable.
    expect(resolves.detail).toContain("status_operation_missing");
    expect(resolves.detail).toContain("exports.invented");
    expect(checkNamed(air, "static/async_status_operation_approved").ok).toBe(false);
  });

  it("refuses a poll target the estate did not approve", () => {
    link(air);
    status(air).state = "generated";
    const approvedArm = checkNamed(air, "static/async_status_operation_approved");
    expect(approvedArm.ok).toBe(false);
    // The whole point of the arm: an agent cannot tell "tool not exposed" from
    // "job not ready", so the certificate has to.
    expect(approvedArm.detail).toContain("generated, not served");
    expect(checkNamed(air, "static/async_contracts_resolve").detail).toContain(
      "status_operation_not_approved",
    );
  });

  it("refuses a mutation as a poll target, naming what each poll would re-apply", () => {
    link(air);
    status(air).effect = {
      kind: "mutation",
      action: "update",
      resource: "export",
      risk: "high",
      reversible: false,
    };
    const readArm = checkNamed(air, "static/async_status_operation_is_read");
    expect(readArm.ok).toBe(false);
    expect(readArm.detail).toContain("high-risk update mutation");
    expect(readArm.detail).toContain("every poll would apply again");
  });

  it("reports an unapproved mutation target as both defects, where the resolver reports one", () => {
    // `resolveAsyncContract` returns at its first finding and checks effect
    // before approval, so it reports only the mutation. The two defects have
    // different owners — one is a compiler/authoring bug, one is a governance
    // decision — and a report that names one hides half the fix. This is the
    // reason the arms are re-derived instead of reading the issue code.
    link(air);
    status(air).state = "generated";
    status(air).effect = {
      kind: "mutation",
      action: "update",
      resource: "export",
      risk: "low",
      reversible: true,
    };
    expect(checkNamed(air, "static/async_contracts_resolve").detail).toContain(
      "status_operation_is_mutation",
    );
    expect(checkNamed(air, "static/async_status_operation_approved").ok).toBe(false);
    expect(checkNamed(air, "static/async_status_operation_is_read").ok).toBe(false);
  });

  it("refuses a poll loop with no exit", () => {
    link(air, { terminalStates: [] });
    const terminates = checkNamed(air, "static/async_poll_loop_terminates");
    expect(terminates.ok).toBe(false);
    expect(terminates.detail).toContain("no terminal state");
  });

  it("refuses a state that is terminal and pending at once", () => {
    // This arm was written against a resolver that only counted terminal states,
    // so a contract whose 'running' meant both stop and continue resolved
    // cleanly — leaving an agent whose halting behavior depended on which list
    // its client read first. `resolveAsyncContract` now refuses it outright, so
    // both this arm AND resolution fail together.
    //
    // The arm stays regardless, and deliberately: it re-derives the overlap from
    // the contract instead of trusting the resolver's verdict. If a later change
    // relaxes the resolver, this is what fails — at certification, rather than in
    // an agent that never learns to stop polling.
    link(air, { terminalStates: ["succeeded", "running"], pendingStates: ["running"] });
    expect(checkNamed(air, "static/async_contracts_resolve").ok).toBe(false);
    const terminates = checkNamed(air, "static/async_poll_loop_terminates");
    expect(terminates.ok).toBe(false);
    expect(terminates.detail).toContain("both terminal and pending");
  });
});

describe("the coordinates nothing else validates", () => {
  it("refuses a job handle that is not in the modeled response", () => {
    // The asymmetry this arm was written against: `statusJobIdParam` was checked
    // against a real parameter while `jobIdField` and `stateField` were accepted
    // as arbitrary strings, so a contract naming a field the response does not
    // carry resolved cleanly and served an agent a path reading `undefined` on
    // every poll. The resolver now validates all three, so resolution fails too.
    //
    // Keeping the arm is the point: it proves the coordinates are addressable by
    // re-deriving them from the response schema, so the guarantee does not rest
    // on the resolver continuing to check them.
    link(air, { jobIdField: "job.identifier" });
    expect(checkNamed(air, "static/async_contracts_resolve").ok).toBe(false);
    const addressable = checkNamed(air, "static/async_contract_fields_addressable");
    expect(addressable.ok).toBe(false);
    expect(addressable.detail).toContain("handle field 'job.identifier'");
  });

  it("refuses a state field that is not in the status response", () => {
    link(air, { stateField: "status" });
    const addressable = checkNamed(air, "static/async_contract_fields_addressable");
    expect(addressable.ok).toBe(false);
    expect(addressable.detail).toContain("state field 'status'");
    expect(addressable.detail).toContain(status(air).id);
  });

  it("declines to judge an unmodeled response, and says the coordinates are unverified", () => {
    link(air, { jobIdField: "job.identifier", stateField: "status" });
    creator(air).output = {};
    status(air).output = {};
    const addressable = checkNamed(air, "static/async_contract_fields_addressable");
    expect(addressable.ok).toBe(true);
    // A pass that reads as a verification would be the worst outcome here: the
    // coordinates are exactly as wrong as in the case above, and only the
    // evidence changed.
    expect(addressable.detail).toContain("unverified, not verified");
  });

  it("declines to judge a response that says extra fields arrive", () => {
    link(air, { jobIdField: "job.identifier" });
    creator(air).output = {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: { job: { type: "object" } },
      },
    };
    status(air).output = {};
    const addressable = checkNamed(air, "static/async_contract_fields_addressable");
    expect(addressable.ok).toBe(true);
    expect(addressable.detail).toContain("unverified, not verified");
  });
});

describe("longRunning and the contract have to agree", () => {
  it("fails a contract on an operation whose description claims to be synchronous", () => {
    link(air);
    creator(air).longRunning = false;
    const coherent = checkNamed(air, "static/async_long_running_flag_coherent");
    expect(coherent.ok).toBe(false);
    expect(coherent.detail).toContain("not flagged long-running");
    expect(certify(air).status).toBe("failed");
  });

  it("passes a long-running operation with no contract, and names it anyway", () => {
    // The deliberate non-failure. The flag alone is incomplete but true, it is
    // where every operation compiled before the contract existed already stands,
    // and the cheapest way to make a failure here go green would be to clear the
    // flag — deleting a true statement to pass a check. Refinement raises the
    // gap; certification refuses to let it be invisible.
    creator(air).longRunning = true;
    const coherent = checkNamed(air, "static/async_long_running_flag_coherent");
    expect(coherent.ok).toBe(true);
    expect(coherent.detail).toContain("state a wait with no contract to finish it");
    expect(coherent.detail).toContain(creator(air).id);
    expect(certify(air).status).toBe("static_passed");
  });
});

describe("a document with nothing asynchronous", () => {
  it("passes every arm with a note that says there was nothing to verify", () => {
    for (const id of ASYNC_CHECK_IDS) {
      const entry = checkNamed(air, id);
      expect(entry.ok).toBe(true);
      expect(entry.detail).toMatch(/no approved operation (carries an async contract|is flagged)/);
    }
  });

  it("ignores an unapproved operation's contract entirely", () => {
    // Certification attests to the *served* surface. A contract on an operation
    // nobody exposed cannot strand anybody, and failing it would block an
    // approval workflow on a tool that is not on the surface being certified.
    link(air, { statusOperationId: "exports.invented" });
    creator(air).state = "generated";
    for (const id of ASYNC_CHECK_IDS) {
      expect(checkNamed(air, id), id).toMatchObject({ ok: true });
    }
  });
});

/**
 * Phase 4 — the safety gate (design doc §15/§16): a `webhook` block whose
 * verification cannot be resolved against a real deploy target must never
 * certify, and neither must a contract with no way to know when it finished.
 * `remote_verify`'s outbound host gets the same `allowedHosts` treatment the
 * runtime itself enforces at request time.
 */

/** An approved `webhook_receiver`-archetyped operation — the shape a webhook target must have. */
function webhookOp(): Operation {
  return Operation.parse({
    id: "exports.completedWebhook",
    canonicalName: "exports_completed_webhook",
    displayName: "Export completed webhook",
    sourceRef: { kind: "openapi", path: "/webhooks/exports-completed", method: "post" },
    effect: { kind: "read", action: "other", resource: "export", risk: "none" },
    archetype: "webhook_receiver",
    input: {
      params: [],
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          job: { type: "object", additionalProperties: false, properties: { id: {} } },
        },
      },
    },
    idempotency: { mode: "none" },
    retries: { mode: "none" },
    confirmation: { required: false },
    auth: { type: "none" },
    cli: { command: "exports webhook-completed" },
    mcp: { toolName: "exports_completed_webhook" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

const webhookVerification = (
  over: Partial<Extract<WebhookSignatureVerification, { scheme: "hmac_sha256_header" }>> = {},
): WebhookSignatureVerification => ({
  scheme: "hmac_sha256_header",
  headerName: "X-Hub-Signature-256",
  encoding: "hex",
  valuePrefix: "sha256=",
  secretRef: "secrets/export-webhook",
  ...over,
});

/** Wire a webhook-only completion contract onto the creating operation, plus its receiver op. */
function linkWebhook(doc: AirDocument, verification: WebhookSignatureVerification): AirDocument {
  const receiver = webhookOp();
  doc.operations.push(receiver);
  const contract: AsyncContract = {
    jobIdField: "job.id",
    terminalStates: ["succeeded", "failed"],
    pendingStates: ["running"],
    webhook: {
      webhookOperationId: receiver.id,
      webhookJobIdField: "job.id",
      signatureVerification: verification,
    },
  };
  creator(doc).asyncContract = contract;
  creator(doc).longRunning = true;
  return doc;
}

function fakeDeployTarget(
  over: Partial<CertificationDeployTarget> = {},
): CertificationDeployTarget {
  return { allowedHosts: [], env: "prod", resolveRef: () => undefined, ...over };
}

describe("Phase 4 — webhook signature refs resolve against the deploy target", () => {
  it("fails certification with a specific diagnostic when a secretRef does not resolve", () => {
    linkWebhook(air, webhookVerification({ secretRef: "secrets/unconfigured" }));
    const target = fakeDeployTarget({ resolveRef: () => undefined });
    const record = certify(air, { deployTarget: target });
    expect(record.status).toBe("failed");
    const arm = record.checks.find((c) => c.id === "static/webhook_signature_refs_resolve");
    expect(arm?.ok).toBe(false);
    // Specific and actionable: names the operation, the scheme, and the missing ref.
    expect(arm?.detail).toContain(creator(air).id);
    expect(arm?.detail).toContain("hmac_sha256_header");
    expect(arm?.detail).toContain("secretRef");
    expect(arm?.detail).toContain("secrets/unconfigured");
  });

  it("passes when the deploy target has the secret configured", () => {
    linkWebhook(air, webhookVerification({ secretRef: "secrets/export-webhook" }));
    const target = fakeDeployTarget({
      resolveRef: (ref) => (ref === "secrets/export-webhook" ? "shh" : undefined),
    });
    const arm = staticChecks(air, undefined, target).find(
      (c) => c.id === "static/webhook_signature_refs_resolve",
    );
    expect(arm?.ok).toBe(true);
    expect(arm?.detail).toContain("resolved against the deploy target");
  });

  it("has nothing to resolve for oidc_jwt beyond structural validation", () => {
    linkWebhook(air, {
      scheme: "oidc_jwt",
      headerName: "Authorization",
      expectedIssuer: "https://accounts.google.com",
      expectedAudienceRef: "config/pubsub-audience",
    });
    // No deploy target at all — still passes, because oidc_jwt has no *Ref* this
    // check resolves against a credential store (see `refsToResolve`).
    const arm = staticChecks(air).find((c) => c.id === "static/webhook_signature_refs_resolve");
    expect(arm?.ok).toBe(true);
    expect(arm?.detail).toContain("oidc_jwt");
  });

  it("fails when no deploy target is supplied at all, with no operator action taken", () => {
    // The Phase 3 -> Phase 4 handoff this phase exists to gate: a bundle carried
    // straight off the generator, with nobody having configured a credential or
    // an allowlist yet, must not certify.
    linkWebhook(air, webhookVerification());
    const record = certify(air);
    expect(record.status).toBe("failed");
    expect(
      record.checks.some((c) => c.id === "static/webhook_signature_refs_resolve" && !c.ok),
    ).toBe(true);
  });
});

describe("Phase 4 — remote_verify's outbound host must be on the deploy target's allowedHosts", () => {
  const remoteVerify = (
    over: Partial<Extract<WebhookSignatureVerification, { scheme: "remote_verify" }>> = {},
  ): WebhookSignatureVerification => ({
    scheme: "remote_verify",
    provider: "paypal",
    verifyEndpointRef: "config/paypal-verify-endpoint",
    credentialRef: "secrets/paypal-cred",
    ...over,
  });
  const resolvePaypalRefs = (ref: string): string | undefined => {
    if (ref === "config/paypal-verify-endpoint") {
      return "https://api.paypal.com/v1/notifications/verify-webhook-signature";
    }
    if (ref === "secrets/paypal-cred") return JSON.stringify({ accessToken: "t", webhookId: "w" });
    return undefined;
  };

  it("fails certification when the verify endpoint's host is missing from allowedHosts", () => {
    linkWebhook(air, remoteVerify());
    const target = fakeDeployTarget({
      allowedHosts: ["someotherhost.example.com"],
      resolveRef: resolvePaypalRefs,
    });
    const record = certify(air, { deployTarget: target });
    expect(record.status).toBe("failed");
    const arm = record.checks.find((c) => c.id === "static/webhook_remote_verify_host_allowed");
    expect(arm?.ok).toBe(false);
    expect(arm?.detail).toContain(creator(air).id);
    expect(arm?.detail).toContain("api.paypal.com");
  });

  it("passes when the verify endpoint's host is on allowedHosts", () => {
    linkWebhook(air, remoteVerify());
    const target = fakeDeployTarget({
      allowedHosts: ["api.paypal.com"],
      resolveRef: resolvePaypalRefs,
    });
    const arm = staticChecks(air, undefined, target).find(
      (c) => c.id === "static/webhook_remote_verify_host_allowed",
    );
    expect(arm?.ok).toBe(true);
    expect(arm?.detail).toContain("confirmed on the deploy target's allowedHosts");
  });
});

describe("Phase 4 — every operation has a way to know when it finished", () => {
  it("fails when a contract declares neither a status operation nor a webhook", () => {
    // A hand-authored (or manifest-patched) contract that names neither — the
    // exact half-a-contract the design doc's header calls worse than none.
    creator(air).asyncContract = {
      jobIdField: "job.id",
      terminalStates: ["succeeded"],
      pendingStates: [],
    } as AsyncContract;
    creator(air).longRunning = true;
    const arm = checkNamed(air, "static/async_completion_source_present");
    expect(arm.ok).toBe(false);
    expect(arm.detail).toContain(creator(air).id);
    expect(arm.detail).toContain("neither a status operation nor a webhook");
    // The composite verdict fails too, in the resolver's own vocabulary.
    expect(checkNamed(air, "static/async_contracts_resolve").detail).toContain(
      "no_completion_source",
    );
    expect(certify(air).status).toBe("failed");
  });
});

describe("Phase 4 — a fully configured webhook contract certifies", () => {
  it("passes every Phase 4 arm, and the document as a whole", () => {
    linkWebhook(air, {
      scheme: "remote_verify",
      provider: "paypal",
      verifyEndpointRef: "config/paypal-verify-endpoint",
      credentialRef: "secrets/paypal-cred",
    });
    const target = fakeDeployTarget({
      allowedHosts: ["api.paypal.com"],
      resolveRef: (ref) => {
        if (ref === "config/paypal-verify-endpoint") {
          return "https://api.paypal.com/v1/notifications/verify-webhook-signature";
        }
        if (ref === "secrets/paypal-cred")
          return JSON.stringify({ accessToken: "t", webhookId: "w" });
        return undefined;
      },
    });
    const record = certify(air, { deployTarget: target });
    expect(record.checks.filter((c) => !c.ok)).toEqual([]);
    expect(record.status).toBe("static_passed");
  });
});
