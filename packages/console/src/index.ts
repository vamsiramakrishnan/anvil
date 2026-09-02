/**
 * @anvil/console — the local review console.
 *
 * A pure projection with no truth of its own: it reads compiled bundles,
 * refinement packs, and benchmark reports from disk, and every write it offers
 * — approving an operation or a capability, recording a pack decision, applying
 * a pack, exporting or importing a harness task — is the same `@anvil/*`
 * library function the CLI command calls, producing the same receipts and
 * honouring the same gates. `contract.ts` is the HTTP API the server
 * (`src/server/`) implements and the UI (`src/ui/`) consumes; both lanes build
 * on it. `anvil console [path]` (in `@anvil/cli`) launches it.
 */

export * from "./contract.js";
