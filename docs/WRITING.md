# Maintaining the documentation

Write for the reader's next task. A tutorial names prerequisites, runnable
commands, expected output, and the next useful check. A reference defines
inputs, outputs, failure behavior, and version or feature boundaries.

Keep supported behavior separate from proposals and dated measurements.
Performance claims need a workload, revision, method, and result. Test counts,
shared schemas, and successful compilation do not establish deployment quality.
Use plain descriptions of the mechanism instead of claims such as seamless,
production-ready, zero overhead, or guaranteed unless the scope is explicit
and supported by a check.

Shared workflows must work from a terminal-capable coding agent. Put host
installation and permission differences in the host-specific guide. Preserve
real adapter names and historical evidence; do not rename a protocol field or
pretend an integration exists to make the prose vendor-neutral.

Edit canonical sources. Regenerate site or command-reference projections through
the repository's existing build. Check links and examples against the current
checkout. Report local, simulated, and live-provider verification separately.

Run `npm --prefix apps/docs run build` to regenerate and validate the site.
The source-to-route map lives in `apps/docs/scripts/sync-content.mjs`.
