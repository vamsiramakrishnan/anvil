# ADR-0019 — Versioned target profiles for agent platforms

**Status:** Accepted

## Context
An agent platform (Gemini Enterprise first) imposes its own requirements —
transport, HTTPS, OAuth setup, an action-selection budget, networking, and
organization policy. If those requirements are hardcoded across a generator, they
leak into Anvil's core: the compiler, the capability contract, and the
runtime-neutral pack identity all start to "know about" a specific platform. That
is the wrong side of the product boundary.

## Decision
Add `@anvil/targets`: model each platform as a **versioned
`AgentPlatformTargetProfile`** (transport/auth/action-limit/networking
requirements plus an explicit `unsupportedAssumptions` list), and generate a
per-target *kit* from a contract plus its profile.

- **`GEMINI_ENTERPRISE_PROFILE`** encodes Gemini Enterprise's custom-MCP
  requirements as data, versioned (`2026.07.0`). It records `verifiedAgainst` and
  states plainly that the requirements MUST be re-verified against the current
  official Google Cloud docs at build/registration time — the profile is a
  starting point, not an authority frozen in code.

- **`generateTargetKit`** emits the full kit deterministically (sorted, no
  timestamps): `target-profile.json`, `setup.json`, `oauth.template.json`,
  `server-description.md`, `action-selection.json`,
  `organization-policy-checklist.md`, `admin-runbook.md`, and
  `compatibility-report.json`. The files become pack artifacts under
  `targets/<id>/`.

- **`validateTarget`** checks transport/HTTPS, the action-selection budget, action
  descriptions, OAuth coverage, and — the safety one — that an irreversible or
  financial mutation **confirms in the contract**, because the platform does not
  confirm for you. `unsupportedAssumptions` makes the "the platform will not
  enforce your auth / an external gateway is not assumed" contract explicit.

Platform requirements live only in the profile and the kit; they never enter AIR,
capability contracts, or the pack digest. A pack's `TargetManifest` binds the
profile *version*, so a requirements change is a new profile version, not an edit
that ripples through the core.

## Consequences
- One pack can carry a complete, validated registration-and-operations kit for a
  platform, with the platform's requirements isolated and versioned.
- Adding a second platform is a new profile (+ generator specifics), not a change
  to the compiler.
- **Deferred:** live verification against current Google Cloud documentation at
  registration time; additional platform profiles; wiring `anvil build --target`
  and attaching the kit to the pack's `targets` at the composition shell.
