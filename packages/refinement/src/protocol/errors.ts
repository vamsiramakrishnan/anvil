import type { z } from "zod";

/** Stable machine-readable reasons an external harness transaction can be refused. */
export type HarnessRejectionCode =
  | "refinement/invalid_task"
  | "refinement/invalid_submission"
  | "refinement/task_integrity_failed"
  | "refinement/task_binding_failed"
  | "refinement/stale_contract"
  | "refinement/repository_revision_mismatch"
  | "refinement/repository_evidence_invalid"
  | "refinement/proposal_rejected"
  /** A group proposal whose measured routing delta is negative (the CLI's
   *  benchmark-scored admission gate refused it before review). */
  | "refinement/group_delta_regressed";

export type HarnessProtocolStage = "task" | "binding" | "evidence" | "validation" | "admission";

export interface HarnessRejection {
  code: HarnessRejectionCode;
  stage: HarnessProtocolStage;
  message: string;
  issues: string[];
}

/** Error carrying the JSON-safe rejection envelope printed by `import-proposal --json`. */
export class HarnessProtocolError extends Error {
  readonly rejection: HarnessRejection;

  constructor(rejection: HarnessRejection) {
    super(rejection.message);
    this.name = "HarnessProtocolError";
    this.rejection = rejection;
  }
}

export function rejectHarness(
  code: HarnessRejectionCode,
  stage: HarnessProtocolStage,
  message: string,
  issues: string[] = [],
): never {
  throw new HarnessProtocolError({ code, stage, message, issues });
}

/** Convert Zod's path-aware issues into stable, concise protocol diagnostics. */
export function zodIssueMessages(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}
