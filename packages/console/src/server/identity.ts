import { IdentityProfile } from "@anvil/air";
import { bundleHash, loadBundleAir, readBundleDir } from "@anvil/generators";
import {
  generateIdentityKit,
  listTargetKitVerifiers,
  prepareIdentityBinding,
  writeTargetKitsAtomically,
} from "@anvil/targets";
import type { ConsoleResponse } from "../contract.js";
import { ConsoleError } from "./errors.js";
import type { Request } from "./mutations.js";
import { findBundle, resolveInsideRoot } from "./workspace.js";

function snapshot(root: string, id: string) {
  const { dir } = findBundle(root, id);
  resolveInsideRoot(root, dir);
  // The shared reader refuses every symlink and binds the same bytes as the CLI.
  const files = readBundleDir(dir);
  return { dir, files, air: loadBundleAir(dir, files), hash: bundleHash(files) };
}

function assertCurrent(actual: string, expected: string) {
  if (actual !== expected)
    throw new ConsoleError(
      "console/refused",
      409,
      "This bundle changed. Refresh and validate the current identity configuration before applying it.",
    );
}

function embeddedProfile(files: Record<string, string>): { present: boolean; raw?: unknown } {
  const setup = files["targets/gemini-enterprise/setup.json"];
  if (setup === undefined) return { present: false };
  try {
    const parsed = JSON.parse(setup);
    const config = parsed?.config;
    return config && typeof config === "object" && Object.hasOwn(config, "identityProfile")
      ? { present: true, raw: config.identityProfile }
      : { present: false };
  } catch {
    // A corrupted deployment config cannot prove that authentication is absent.
    return { present: true };
  }
}

export function bundleRequiresIdentity(files: Record<string, string>): boolean {
  return (
    Object.keys(files).some((path) => path.startsWith("targets/identity/")) ||
    embeddedProfile(files).present
  );
}

/** Read-only projection. Invalid persisted data is never returned as an editable profile. */
export function identityView(root: string, id: string): ConsoleResponse<"identity"> {
  const { files, air, hash } = snapshot(root, id);
  const standalone = Object.keys(files).some((path) => path.startsWith("targets/identity/"));
  const embedded = standalone ? { present: false } : embeddedProfile(files);
  const targetId = embedded.present ? "gemini-enterprise" : "identity";
  const verifier = listTargetKitVerifiers().find((item) => item.id === targetId);
  if (!verifier) throw new Error("Identity kit verifier is unavailable.");
  const result = verifier.verify(air, files);
  const parsed = IdentityProfile.safeParse(embedded.present ? embedded.raw : result.config);
  let profile = parsed.success ? parsed.data : undefined;
  let profileDigest: string | undefined;
  if (profile) {
    try {
      profileDigest = generateIdentityKit(air, profile).digest;
    } catch {
      profile = undefined;
    }
  }
  return {
    bundleId: id,
    bundleHash: hash,
    configured: standalone || embedded.present,
    ...(profile ? { profile, profileDigest } : {}),
    integrity: {
      state:
        !standalone && !embedded.present
          ? "missing"
          : !profile
            ? "invalid"
            : result.ok
              ? "fresh"
              : "stale",
      findings: result.findings.map((finding) => finding.detail),
    },
    verifiedLive: false,
    files: result.actualFiles,
  };
}

/** No provider contact, credential reads or writes. The shared generator checks local AIR bindings. */
export function validateIdentity(
  root: string,
  id: string,
  body: Request<"validateIdentity">,
): ConsoleResponse<"validateIdentity"> {
  const { air, hash, files } = snapshot(root, id);
  assertCurrent(hash, body.bundleHash);
  const base = { bundleId: id, bundleHash: hash };
  const parsed = IdentityProfile.safeParse(body.profile);
  if (!parsed.success)
    return {
      ...base,
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
      files: [],
    };
  try {
    const kit = prepareIdentityBinding(air, parsed.data, files);
    return {
      ...base,
      ok: true,
      issues: [],
      profile: parsed.data,
      profileDigest: kit.digest,
      files: kit.files.map((file) => file.path),
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      issues: [{ path: "authorization", message: (error as Error).message }],
      files: [],
    };
  }
}

/** Same validation and atomic target installation as `anvil target identity`. */
export function applyIdentity(
  root: string,
  id: string,
  body: Request<"applyIdentity">,
): ConsoleResponse<"applyIdentity"> {
  const validation = validateIdentity(root, id, body);
  if (!validation.ok || !validation.profile)
    throw new ConsoleError("console/refused", 422, "Identity configuration is invalid.", {
      issues: validation.issues.map((issue) => `${issue.path || "profile"}: ${issue.message}`),
    });
  const { dir, air, hash, files } = snapshot(root, id);
  assertCurrent(hash, body.bundleHash);
  const kit = prepareIdentityBinding(air, validation.profile, files);
  const written = writeTargetKitsAtomically(dir, kit.files);
  return { written: true, identity: identityView(root, id), warnings: written.warnings };
}
