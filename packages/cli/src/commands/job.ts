import type { AirDocument, Operation } from "@anvil/air";
import {
  allowedHostsFor,
  type ExecuteContext,
  FetchTransport,
  handleJobAnswer,
  type JobAnswerDecision,
  loadRuntimeConfig,
  resolveCredentials,
  resolveLedger,
} from "@anvil/runtime";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { exitCodeFor } from "../tool-cli.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/**
 * `anvil job answer <dir> <job_id> --operation <opId> --decision approve|reject [--note ...]`
 * (design doc `docs/design/async-events-and-callbacks.md` §8, §14). A thin,
 * authenticated wrapper around `handleJobAnswer` — the SAME AIR
 * operation-call path every other mutation goes through, not a second
 * execution primitive. It does not resume a paused Anvil call: the upstream
 * itself already tracks its own pending-approval state, and this places the
 * real "approve/reject this thing" call the spec already exposes.
 *
 * AIR does not model a dedicated decision-operation link (only
 * `AsyncContract`, for the poll/webhook side of completion — see
 * `packages/runtime/src/job-answer.ts`'s own doc comment on why not: every
 * vendor's real decision endpoint has its own param shape a naming
 * convention cannot guess). So `--operation` names which approved mutation
 * IS the decision call, and `--input` supplies whatever of that operation's
 * own parameters the decision needs beyond `job_id`/`decision`/`note` — the
 * same "the caller who knows this operation's shape supplies the mapping"
 * posture `handleJobAnswer` itself documents.
 */
export function registerJob(parent: Command, ctx: CommandContext): void {
  const job = annotate(
    parent.command("job").summary("Answer a job awaiting a human decision mid-flight."),
    { mutates: false },
  );

  annotate(
    job
      .command("answer")
      .summary("Submit a human decision for a job awaiting approval.")
      .description(
        "Calls the named APPROVED mutation as the real upstream decision operation — the exact same AIR operation-call path every other mutation uses, authenticated and idempotency-tracked identically. Not a resume of a paused execution: the upstream already tracks its own pending-approval state (AsyncContract.pendingStates including 'awaiting_human_input'); this places the call it is waiting on. --input supplies any of the decision operation's OWN parameters beyond job_id/decision/note (e.g. an application id in a different field name) as a JSON object merged in verbatim.",
      )
      .argument("<dir>", "generated bundle directory or air.yaml")
      .argument("<job_id>", "the job handle this decision answers")
      .requiredOption("--operation <id>", "the approved mutation to call as the decision operation")
      .requiredOption("--decision <decision>", "approve or reject")
      .option("--note <text>", "optional free-text rationale")
      .option("--input <json>", "JSON object of the decision operation's own extra parameters")
      .option("--confirm", "confirm a non-idempotent decision call")
      .option("--idempotency-key <key>", "caller-supplied idempotency key for the decision call")
      .option("--json", "emit the full result as JSON")
      .action(async (dir: string, jobId: string, opts: JobAnswerCliOptions) => {
        ctx.code = await runJobAnswer(dir, jobId, opts, ctx.io);
      }),
    { mutates: true },
  );
}

interface JobAnswerCliOptions {
  operation: string;
  decision: string;
  note?: string;
  input?: string;
  confirm?: boolean;
  idempotencyKey?: string;
  json?: boolean;
}

function findDecisionOperation(air: AirDocument, ref: string): Operation | undefined {
  return air.operations.find(
    (op) =>
      op.state === "approved" &&
      (op.id === ref || op.cli.command === ref || op.mcp.toolName === ref),
  );
}

async function runJobAnswer(
  dir: string,
  jobId: string,
  opts: JobAnswerCliOptions,
  io: CliIO,
): Promise<number> {
  const air = loadAir(dir);
  if (opts.decision !== "approve" && opts.decision !== "reject") {
    io.err(`--decision must be "approve" or "reject", got "${opts.decision}".`);
    return 2;
  }
  const operation = findDecisionOperation(air, opts.operation);
  if (!operation) {
    io.err(
      `No approved operation "${opts.operation}" (matched against operation id, CLI command, or MCP tool name).`,
    );
    return 2;
  }
  let extraInput: Record<string, unknown> = {};
  if (opts.input !== undefined) {
    try {
      const parsed = JSON.parse(opts.input);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      extraInput = parsed as Record<string, unknown>;
    } catch {
      io.err("--input must be a JSON object.");
      return 2;
    }
  }

  const env = process.env;
  const config = loadRuntimeConfig(env);
  const baseUrl = air.service.servers[0]?.url ?? "";
  const allowedHosts = allowedHostsFor(config.allowedHosts, baseUrl, true);
  const executeContext: ExecuteContext = {
    transport: new FetchTransport(),
    serviceId: air.service.id,
    credentials: resolveCredentials(config, { env }),
    ledger: resolveLedger(config.ledger, { resultTtlMs: config.ledgerResultTtlSeconds * 1000 }),
    baseUrl,
    authProfile: config.authProfile,
    allowedHosts,
    env: config.env,
    timeoutMs: config.upstreamTimeoutMs,
  };

  const outcome = await handleJobAnswer({
    operation,
    decision: opts.decision as JobAnswerDecision,
    note: opts.note,
    jobId,
    buildOperationInput: () => extraInput,
    executeContext,
    idempotencyKey: opts.idempotencyKey,
    confirm: opts.confirm === true,
  });

  if (outcome.outcome === "invalid_decision" || outcome.outcome === "unauthorized") {
    if (opts.json === true) {
      io.err(JSON.stringify({ error: outcome.outcome, reason: outcome.reason }, null, 2));
    } else {
      io.err(`${outcome.outcome}: ${outcome.reason}`);
    }
    return outcome.outcome === "unauthorized" ? 4 : 2;
  }

  const result = outcome.result;
  if (result.outcome === "success") {
    io.out(
      opts.json === true
        ? JSON.stringify(result.data ?? null, null, 2)
        : `Decision recorded. ${JSON.stringify(result.data ?? null)}`,
    );
    return 0;
  }
  if (result.outcome === "dry_run") {
    io.out(JSON.stringify(result.plan, null, 2));
    return 0;
  }
  io.err(JSON.stringify(result.envelope, null, 2));
  return exitCodeFor(result.envelope.error.code);
}
