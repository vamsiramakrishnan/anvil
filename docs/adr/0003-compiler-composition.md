# ADR-0003 — Compiler composition (honest linear pipeline, not a plugin framework)

**Status:** Accepted

## Context
The brief asks that adding a parser / pass / generator not require editing the
compiler core, and sketches `SourceParser` / `CompilerPass` / `ArtifactGenerator`
interfaces. It *also* warns against premature abstraction: interfaces with one
trivial implementation, registries with no real use.

Today Anvil has **one** parser (OpenAPI/Swagger) and **one** runtime target
(Cloud Run). Passes are small internal functions composed linearly in `compile()`.

## Decision
Keep the compiler as an **honest linear composition**. Do *not* introduce
`SourceParser`/`CompilerPass`/`ArtifactGenerator` interfaces with a single
implementation each — that is exactly the fake extensibility the brief forbids
("do not add an interface because the architecture document says plugin").

The extension seam that actually matters is made explicit and **tested**: a
source format is selected by detected `SourceKind`, and every downstream pass
(classify, validate, discover-capabilities, generate) is **format-agnostic over
AIR**. Adding GraphQL/gRPC/WSDL means adding a parser that emits AIR — not editing
classify/validate/generate. Generators are already independent functions composed
in `bundle.ts`; that is a real second+ implementation and needs no registry.

## Consequences
- No speculative framework; the core stays small and readable.
- When a genuine second parser lands, promoting the parser selection to a typed
  registry becomes justified — and only then.
