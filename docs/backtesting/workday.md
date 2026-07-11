# Workday, Icertis, BlackLine — why these are deferred

Anvil compiles from a real, vendor-published OpenAPI/Swagger spec. It does not
guess API shape from documentation prose, and it does not fabricate a spec —
doing either would make every finding from "backtesting" meaningless, since
there would be no real vendor contract to have compiled correctly or
incorrectly against.

For all three of these systems, a live check (this session, see
`docs/backtesting/README.md`'s triage table) found:

- **Workday**: `community.workday.com`'s REST API reference is a client-
  rendered app that resolves to a Workday Community login / customer-tenant
  wall; there is no static spec file fetchable without an account. The only
  Workday-authored MCP-adjacent repo (`Workday/ai-conversation-bridge`) is an
  explicit demo over mock/static data, not a real API-backed server —  not a
  usable "mature reference" to backtest against either.
- **Icertis**: API documentation lives in an "APIs Knowledge Center" that
  requires an ICI license and a Dev Portal role. No public spec URL exists.
  No known MCP server, official or community.
- **BlackLine**: the developer portal responds over plain HTTP, but real
  content (spec downloads, the API Explorer) requires an OAuth client tied to
  a BlackLine account. No known MCP server, official or community.

All three share the same shape: genuine enterprise SaaS whose API surface is
provisioned per customer tenant, so there is no one universal, anonymous,
fetchable contract the way Atlassian, GitHub, or Stripe publish one. This is
not an Anvil gap — it's a real constraint on what "backtesting against a real
spec" can mean for this category of product.

## What would unblock this

Anvil's compiler doesn't care where a spec comes from as long as it's a real
OpenAPI/Swagger document — the same `anvil compile` path used for Jira and
Confluence would work unchanged. To actually backtest one of these three:

1. A Workday/Icertis/BlackLine customer exports their tenant's real OpenAPI
   spec (Workday, for instance, does let a logged-in customer generate one),
   and hands Anvil that file — exactly the same shape of input as any
   customer's private API today.
2. For the "mature reference MCP" side of the comparison, either an official
   vendor MCP ships (none do yet, per the triage), or the backtest compares
   against the vendor's own REST API documentation/conventions directly
   instead of a third-party MCP tool list.

Until then, these three stay out of the backtest corpus rather than being
represented by a fabricated stand-in spec.
