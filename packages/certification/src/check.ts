import type { CertificationCheck } from "./model.js";

/** One check outcome — data, never a throw. Shared by every check module. */
export const check = (
  id: string,
  phase: CertificationCheck["phase"],
  ok: boolean,
  detail?: string,
): CertificationCheck => ({ id, phase, ok, detail });
