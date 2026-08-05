import { z } from "zod";
import { ErrorCode } from "./enums.js";

/** A stable Anvil error plus its reviewed upstream match and recovery action. */
export const ErrorSpec = z.object({
  code: ErrorCode,
  upstream: z
    .object({
      httpStatus: z.number().int().optional(),
      /** Stable domain error code carried by the upstream response, when declared. */
      code: z.string().min(1).max(128).optional(),
    })
    .optional(),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
  safeToRetry: z.boolean().optional(),
  /** Structured next action for a coding agent; never copied from raw upstream text. */
  recovery: z
    .object({
      action: z.string().min(1),
      fieldPath: z.string().min(1).optional(),
    })
    .optional(),
});
export type ErrorSpec = z.infer<typeof ErrorSpec>;
