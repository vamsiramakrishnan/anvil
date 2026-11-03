import { useEffect, useRef, useState } from "react";
import type { ConsoleResponse } from "../../contract.js";
import { type ConsoleApi, type ConsoleApiError, toConsoleApiError } from "../api.js";
import { Chip, CodeBlock, ErrorBox, KV, Label, Panel, Receipt, Tag } from "../components.js";
import { useLoad } from "../hooks.js";
import { href } from "../model.js";
import { LoadState, PageHeader } from "../workbench-components.js";

type Identity = ConsoleResponse<"identity">;
type Validation = ConsoleResponse<"validateIdentity">;
const MAX_PROFILE_BYTES = 512 * 1024;
const profileText = (profile: unknown) => (profile ? `${JSON.stringify(profile, null, 2)}\n` : "");

/** A separate keyed session prevents drafts or late responses crossing bundle boundaries. */
export function IdentityView(props: { api: ConsoleApi; bundleId: string }) {
  return <IdentitySession key={props.bundleId} {...props} />;
}

function IdentitySession({ api, bundleId }: { api: ConsoleApi; bundleId: string }) {
  const loaded = useLoad(() => api.identity(bundleId), [bundleId]);
  const [receipt, setReceipt] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  if (!loaded.data) return <LoadState loaded={loaded} />;
  const identity = loaded.data;
  const canInspectArtifacts = identity.integrity.state === "fresh";
  const artifactEntry = canInspectArtifacts
    ? ["targets/identity/profile.json", "targets/gemini-enterprise/setup.json"].find((path) =>
        identity.files.includes(path),
      )
    : undefined;
  return (
    <div className="stack">
      <PageHeader
        eyebrow="connector configuration"
        title="Identity"
        description="Configure the identity authority used by this connector."
        actions={
          <button
            type="button"
            className="btn"
            disabled={loaded.refreshing}
            onClick={() => void loaded.reload()}
          >
            Refresh profile
          </button>
        }
      />
      <div className="callout">
        <strong>Connector identity is independent of Gemini sign-in.</strong>
        <p>
          Employees may sign into Gemini Enterprise with Entra ID while this connector validates
          SiteMinder credentials. Configure the connector issuer here; Gemini sign-in does not
          change it.
        </p>
      </div>
      {loaded.error ? <ErrorBox error={loaded.error} /> : null}
      {receipt ? <Receipt>{receipt}</Receipt> : null}
      {warnings.length ? (
        <ul className="issues" aria-label="Identity warnings">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <IdentitySummary identity={identity} />
      <IdentityEditor
        key={identity.bundleHash}
        api={api}
        identity={identity}
        onApplied={async (result) => {
          setWarnings(result.warnings);
          setReceipt(
            "Identity kit applied. Review deployment configuration and certify the updated bundle.",
          );
          await loaded.reload();
        }}
      />
      <Panel title="Deployment handoff">
        <p>
          Applying generates the same identity kit as the CLI. It does not deploy the connector or
          approve operations. Merge the generated environment configuration into your deployment,
          configure secret references and authorization extensions, then certify and test the live
          endpoint.
        </p>
        <p>
          Live authentication, SiteMinder interoperability, IAM permissions and policy decisions
          remain unverified.
        </p>
        <div className="actions">
          {artifactEntry ? (
            <a className="btn" href={href(bundleId, "artifacts", { path: artifactEntry })}>
              Review generated identity files
            </a>
          ) : null}
          <a className="btn" href={href(bundleId, "evidence")}>
            Review checks and evidence
          </a>
        </div>
        {identity.files.length ? (
          <ul aria-label="Generated identity files">
            {identity.files.map((path) => (
              <li key={path}>
                {canInspectArtifacts ? (
                  <a href={href(bundleId, "artifacts", { path })}>
                    <code>{path}</code>
                  </a>
                ) : (
                  <code>{path}</code>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  );
}

function IdentitySummary({ identity }: { identity: Identity }) {
  const profile = identity.profile;
  return (
    <Panel
      title="Current connector authority"
      aside={
        <Chip
          value={identity.integrity.state === "fresh" ? "passed" : "warning"}
          label={identity.integrity.state}
        />
      }
    >
      {!profile ? (
        <p>
          {identity.configured
            ? "The recorded profile is invalid. Inspect the findings before replacing it."
            : "No identity profile is attached. Import a reviewed profile or paste its non-secret JSON below."}
        </p>
      ) : (
        <ProfileDetails profile={profile} />
      )}
      <KV
        rows={[
          ["Profile SHA-256", <code key="digest">{identity.profileDigest ?? "—"}</code>],
          ["Bundle SHA-256", <code key="bundle">{identity.bundleHash}</code>],
          ["Live qualification", <Tag key="live">unverified</Tag>],
        ]}
      />
      {identity.integrity.findings.length ? (
        <ul className="issues" aria-label="Identity integrity findings">
          {identity.integrity.findings.map((finding) => (
            <li key={finding}>{finding}</li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

function ProfileDetails({ profile }: { profile: NonNullable<Identity["profile"]> }) {
  const auth = profile.authentication;
  return (
    <KV
      rows={[
        ["Profile", profile.id],
        ["Provider", auth.provider],
        ["Issuer", <code key="issuer">{auth.issuer}</code>],
        ["Audience", <code key="audience">{auth.audience}</code>],
        [
          "Verification endpoint",
          <code key="verification">{auth.introspection?.endpoint ?? auth.jwksUri}</code>,
        ],
        ...(auth.introspection
          ? [
              [
                "Credential references",
                `${auth.introspection.clientIdEnv}, ${auth.introspection.clientSecretEnv}`,
              ] as const,
              ["Audience proof", auth.introspection.audienceSource] as const,
            ]
          : []),
        [
          "Tenant mapping",
          profile.mapping.tenant.source === "fixed"
            ? `Fixed: ${profile.mapping.tenant.value}`
            : `Claim: ${profile.mapping.tenant.claim}; allowed: ${profile.mapping.tenant.allowed.join(", ")}`,
        ],
        ["Incoming scopes", auth.requiredScopes.join(", ") || "No required scopes"],
        ["Upstream scopes", profile.mapping.upstreamScopes.join(", ") || "No scopes granted"],
        ["Authorization", profile.authorization.adapter],
      ]}
    />
  );
}

function IdentityEditor({
  api,
  identity,
  onApplied,
}: {
  api: ConsoleApi;
  identity: Identity;
  onApplied: (result: ConsoleResponse<"applyIdentity">) => Promise<void>;
}) {
  const [text, setText] = useState(() => profileText(identity.profile));
  const [checked, setChecked] = useState<{ text: string; result: Validation }>();
  const [busy, setBusy] = useState<"validate" | "apply">();
  const [error, setError] = useState<ConsoleApiError>();
  const [localIssue, setLocalIssue] = useState<string>();
  const serial = useRef(0);
  useEffect(
    () => () => {
      serial.current++;
    },
    [],
  );
  const change = (value: string) => {
    serial.current++;
    setText(value);
    setChecked(undefined);
    setError(undefined);
    setLocalIssue(undefined);
    setBusy(undefined);
  };
  const validation = checked?.text === text ? checked.result : undefined;
  const canApply =
    validation?.ok && validation.profile && validation.bundleHash === identity.bundleHash;
  const validate = async () => {
    const request = ++serial.current;
    setChecked(undefined);
    setError(undefined);
    setLocalIssue(undefined);
    let profile: unknown;
    try {
      if (new TextEncoder().encode(text).length > MAX_PROFILE_BYTES) throw new Error("size");
      profile = JSON.parse(text);
    } catch {
      setLocalIssue("Enter valid profile JSON, no larger than 512 KiB.");
      return;
    }
    setBusy("validate");
    try {
      const result = await api.validateIdentity(identity.bundleId, {
        profile,
        bundleHash: identity.bundleHash,
      });
      if (request === serial.current) setChecked({ text, result });
    } catch (caught) {
      if (request === serial.current) setError(toConsoleApiError(caught));
    } finally {
      if (request === serial.current) setBusy(undefined);
    }
  };
  const apply = async () => {
    if (!canApply || !validation?.profile) return;
    const request = ++serial.current;
    setBusy("apply");
    setError(undefined);
    try {
      const result = await api.applyIdentity(identity.bundleId, {
        profile: validation.profile,
        bundleHash: validation.bundleHash,
      });
      if (request === serial.current) {
        setChecked(undefined);
        await onApplied(result);
      }
    } catch (caught) {
      if (request === serial.current) {
        setChecked(undefined);
        setError(toConsoleApiError(caught));
      }
    } finally {
      if (request === serial.current) setBusy(undefined);
    }
  };
  return (
    <Panel
      title="Reviewed profile"
      aside={
        validation ? (
          <Chip
            value={validation.ok ? "passed" : "failed"}
            label={validation.ok ? "valid preview" : "needs changes"}
          />
        ) : null
      }
    >
      <p>
        Import or paste an IdentityProfile JSON document. Use environment-variable names for
        credential references. Do not include tokens, cookies, passwords, or client-secret values.
        Validate checks the shared schema and this bundle’s operation bindings without contacting
        the identity provider.
      </p>
      <label className="field">
        <Label>Import profile JSON</Label>
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy === "apply"}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            const request = ++serial.current;
            setChecked(undefined);
            setError(undefined);
            setLocalIssue(undefined);
            setBusy(undefined);
            if (file.size > MAX_PROFILE_BYTES) {
              setLocalIssue("Profile files must be no larger than 512 KiB.");
              return;
            }
            try {
              const value = await file.text();
              if (request === serial.current) change(value);
            } catch {
              if (request === serial.current) setLocalIssue("The profile file could not be read.");
            }
          }}
        />
      </label>
      <label className="field">
        <Label>Identity profile JSON</Label>
        <textarea
          className="source-editor"
          spellCheck={false}
          value={text}
          disabled={busy === "apply"}
          onChange={(event) => change(event.target.value)}
        />
      </label>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={Boolean(busy) || !text.trim()}
          onClick={() => void validate()}
        >
          {busy === "validate" ? "Validating…" : "Validate profile"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={Boolean(busy) || !canApply}
          onClick={() => void apply()}
        >
          {busy === "apply" ? "Applying…" : "Apply identity kit"}
        </button>
      </div>
      {localIssue ? (
        <p className="error" role="alert">
          {localIssue}
        </p>
      ) : null}
      {error ? <ErrorBox error={error} /> : null}
      {validation?.issues.length ? (
        <ul className="issues" aria-label="Identity validation issues">
          {validation.issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <code>{issue.path || "<root>"}</code>: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {validation?.ok ? (
        <div className="callout" role="status">
          <strong>Validated against bundle {validation.bundleHash.slice(0, 12)}</strong>
          <p>
            Profile SHA-256: <code>{validation.profileDigest}</code>. Apply will generate{" "}
            {validation.files.length} files. Editing the profile requires a new validation.
          </p>
          {validation.profile ? (
            <details>
              <summary>Review normalized profile</summary>
              <ProfileDetails profile={validation.profile} />
              <CodeBlock
                label="Normalized profile JSON"
                text={JSON.stringify(validation.profile, null, 2)}
              />
            </details>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
