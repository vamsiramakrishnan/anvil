import type {
  Diagnostic,
  PathGrammar,
  PathGrammarClassification,
  PathGrammarEvidence,
  SourceKind,
} from "@anvil/air";
import { snakeCase } from "@anvil/air";
import {
  CRUD_SEGMENT_WORDS,
  concreteResourceSegments,
  decomposeSegment,
  isBulkVerbSegment,
} from "./naming.js";

/**
 * Estate-wide path-grammar classification: is this estate's URL grammar nouns
 * (REST — the HTTP method carries the verb) or verbs (RPC-over-HTTP — the
 * terminal path segment carries it)?
 *
 * The lesson this module encodes, measured across six untrimmed estates in
 * docs/design/resource-derivation-and-tool-name-stutter.md: the naming
 * mangles were never bad heuristics, they were grammar being *implicit*.
 * Slack (grammar DECLARED in the URL as dotted segments) had a 0% naming
 * defect rate; Plaid (a real RPC grammar left UNDECLARED) had 72% until the
 * trailing-verb rules learned to read it. So the grammar is classified ONCE,
 * from cheap estate-wide evidence, declared in AIR
 * (`service.source.pathGrammar`) with the counts that decided it, and used to
 * drive the naming pass's estate-context gate — instead of a hardcoded list of
 * source kinds deciding silently.
 *
 * Deterministic by construction: one pass over (method, path) pairs, closed
 * vocabularies shared with `deriveNames` (the same CRUD word list, the same
 * segment cleaning, the same bulk-verb and dotted-method readers), no network,
 * no model. The classifier NAMES what the naming pass will do; it never
 * introduces a second opinion about what a verb segment is.
 */

export interface PathGrammarOperationShape {
  /** The wire method as parsed (lowercase HTTP method). */
  method: string;
  /** The raw path template, `{param}` placeholders included. */
  path: string;
}

export interface PathGrammarResult {
  grammar: PathGrammar;
  diagnostics: Diagnostic[];
}

/**
 * Source kinds whose paths a protocol adapter wrote itself
 * (`/<SyntheticWrapper>/<methodName>`). Their grammar is declared by
 * construction — NetSuite's WSDL lowers to `/NetSuitePortType/get`, where the
 * bare CRUD method name must stay the resource — so classification needs no
 * evidence beyond the kind.
 */
const ADAPTER_LOWERED_KINDS: ReadonlySet<SourceKind> = new Set([
  "wsdl",
  "graphql",
  "protobuf",
  "mcp",
]);

/**
 * Source kinds whose paths are real resource paths. This is the pre-classifier
 * kind gate, kept as the AMBIGUOUS fallback only: when the estate's own
 * evidence declines to pick a grammar, name derivation behaves exactly as it
 * did before the classifier existed (estate context for these kinds, none for
 * the rest), so an undecidable estate never changes behavior.
 */
const RESOURCE_PATH_KINDS: ReadonlySet<SourceKind> = new Set([
  "openapi",
  "swagger",
  "discovery",
  "postman",
  "odata",
]);

/* ------------------------------------------------------------------ evidence
 * Thresholds, named and calibrated against the measured estates (see
 * docs/SOURCE_FORMATS.md#path-grammar-classification for the table). Each
 * signal has an RPC pole and a REST pole with a deliberate abstention band
 * between them, so a middling value votes for neither side rather than
 * whichever side a single cutoff happens to face.
 */

/** Terminal verb segments: Plaid 0.718 vs Zendesk 0.109 (the worst REST case). */
const VERB_TERMINAL_RPC_MIN = 0.4;
const VERB_TERMINAL_REST_MAX = 0.15;
/** GET/HEAD share: Plaid 0.014 vs BigQuery 0.381 (the lowest REST case). */
const READ_METHOD_RPC_MAX = 0.1;
const READ_METHOD_REST_MIN = 0.3;
/** `{param}` paths: Plaid 0.011 vs Zendesk 0.567 / SAP OData 0.545. */
const PARAMETERIZED_RPC_MAX = 0.05;
const PARAMETERIZED_REST_MIN = 0.25;
/** Dotted terminal methods: Slack 1.0; TripPin's bound operations reach 0.12. */
const DOTTED_TERMINAL_MIN = 0.5;

/** One pass over the estate: every signal the classification can cite. */
export function measurePathGrammarEvidence(
  operations: readonly PathGrammarOperationShape[],
): PathGrammarEvidence {
  let readMethodOperations = 0;
  let parameterizedPathOperations = 0;
  let verbTerminalOperations = 0;
  let dottedTerminalOperations = 0;
  /** verb word -> distinct parent paths it terminates. */
  const verbParents = new Map<string, Set<string>>();
  for (const op of operations) {
    if (op.method === "get" || op.method === "head") readMethodOperations++;
    if (op.path.includes("{")) parameterizedPathOperations++;
    const segments = concreteResourceSegments(op.path);
    const terminal = segments[segments.length - 1];
    if (terminal === undefined) continue;
    if (decomposeSegment(terminal).rpcAction !== undefined) {
      dottedTerminalOperations++;
      continue;
    }
    const words = snakeCase(terminal).split("_").filter(Boolean);
    const bareCrudVerb = words.length === 1 && CRUD_SEGMENT_WORDS.has(words[0] as string);
    if (bareCrudVerb || isBulkVerbSegment(terminal)) {
      verbTerminalOperations++;
      const verb = words[0] as string;
      const parents = verbParents.get(verb) ?? new Set<string>();
      parents.add(segments.slice(0, -1).join("/"));
      verbParents.set(verb, parents);
    }
  }
  const repeatedVerbWords = [...verbParents.values()].filter((parents) => parents.size >= 2).length;
  return {
    operations: operations.length,
    readMethodOperations,
    parameterizedPathOperations,
    verbTerminalOperations,
    dottedTerminalOperations,
    repeatedVerbWords,
  };
}

interface Votes {
  rpc: string[];
  rest: string[];
}

/** Each signal's vote, as a named reason carrying its own count. */
function tallyVotes(evidence: PathGrammarEvidence): Votes {
  const n = evidence.operations;
  const rpc: string[] = [];
  const rest: string[] = [];
  const fraction = (count: number): string => `${count}/${n}`;
  if (evidence.verbTerminalOperations >= n * VERB_TERMINAL_RPC_MIN) {
    rpc.push(`${fraction(evidence.verbTerminalOperations)} operations end in a CRUD-verb segment`);
  } else if (evidence.verbTerminalOperations <= n * VERB_TERMINAL_REST_MAX) {
    rest.push(
      `only ${fraction(evidence.verbTerminalOperations)} operations end in a CRUD-verb segment`,
    );
  }
  if (evidence.readMethodOperations <= n * READ_METHOD_RPC_MAX) {
    rpc.push(
      `only ${fraction(evidence.readMethodOperations)} operations use GET/HEAD (method mix collapsed)`,
    );
  } else if (evidence.readMethodOperations >= n * READ_METHOD_REST_MIN) {
    rest.push(`${fraction(evidence.readMethodOperations)} operations use GET/HEAD`);
  }
  if (evidence.parameterizedPathOperations <= n * PARAMETERIZED_RPC_MAX) {
    rpc.push(
      `only ${fraction(evidence.parameterizedPathOperations)} paths carry a {param} segment`,
    );
  } else if (evidence.parameterizedPathOperations >= n * PARAMETERIZED_REST_MIN) {
    rest.push(`${fraction(evidence.parameterizedPathOperations)} paths carry a {param} segment`);
  }
  return { rpc, rest };
}

/**
 * The estate-evidence verdict alone (no source kind, no manifest): a grammar
 * when one side carries at least two signals and the other side none, and
 * `ambiguous` — an explicit refusal to guess, never a silent pick — whenever
 * the signals split or too few commit.
 */
function classifyFromEvidence(evidence: PathGrammarEvidence): {
  classification: PathGrammarClassification;
  votes: Votes;
} {
  const votes = tallyVotes(evidence);
  if (evidence.operations === 0) return { classification: "ambiguous", votes };
  if (evidence.dottedTerminalOperations >= evidence.operations * DOTTED_TERMINAL_MIN) {
    return { classification: "rpc_dotted", votes };
  }
  if (votes.rpc.length > 0 && votes.rest.length > 0) {
    return { classification: "ambiguous", votes };
  }
  if (votes.rpc.length >= 2) return { classification: "rpc_plain", votes };
  if (votes.rest.length >= 2) return { classification: "resource_grammar", votes };
  return { classification: "ambiguous", votes };
}

const describeVotes = (side: string, reasons: string[]): string =>
  `${side}: ${reasons.length === 0 ? "no committed signal" : reasons.join("; ")}`;

/**
 * Classify the estate's path grammar. Adapter-lowered kinds classify by
 * construction (basis `source_kind`); everything else classifies from the
 * one-pass estate evidence (basis `estate_evidence`); an explicit manifest
 * `path_grammar` declaration wins over both (basis `manifest`) — the operator
 * is allowed to know their API better than the counts, but a declaration that
 * contradicts a definite measured verdict is recorded as a warning rather than
 * applied silently.
 */
export function classifyPathGrammar(
  kind: SourceKind,
  operations: readonly PathGrammarOperationShape[],
  override?: Exclude<PathGrammarClassification, "ambiguous">,
): PathGrammarResult {
  const evidence = measurePathGrammarEvidence(operations);
  const diagnostics: Diagnostic[] = [];

  const measured: { classification: PathGrammarClassification; votes: Votes } =
    ADAPTER_LOWERED_KINDS.has(kind)
      ? { classification: "adapter_lowered", votes: { rpc: [], rest: [] } }
      : classifyFromEvidence(evidence);

  if (override !== undefined) {
    if (measured.classification !== "ambiguous" && measured.classification !== override) {
      const measuredWhy = ADAPTER_LOWERED_KINDS.has(kind)
        ? `the "${kind}" adapter wrote these paths itself`
        : [
            describeVotes("rpc", measured.votes.rpc),
            describeVotes("resource", measured.votes.rest),
          ].join(" · ");
      diagnostics.push({
        level: "warning",
        code: "path_grammar_override_contradicts_evidence",
        message:
          `Manifest declares path_grammar "${override}", but the estate reads as ` +
          `"${measured.classification}" (${measuredWhy}). The declaration is applied — the ` +
          "operator may know this API better than the counts — and recorded here for review.",
      });
    }
    return { grammar: { classification: override, basis: "manifest", evidence }, diagnostics };
  }

  if (measured.classification === "ambiguous" && evidence.operations > 0) {
    diagnostics.push({
      level: "warning",
      code: "path_grammar_ambiguous",
      message:
        "The estate's path grammar is ambiguous between rpc_plain and resource_grammar " +
        `(${describeVotes("rpc", measured.votes.rpc)} · ` +
        `${describeVotes("resource", measured.votes.rest)}). ` +
        "Name derivation falls back to the source kind's default reading " +
        `(${RESOURCE_PATH_KINDS.has(kind) ? "resource paths" : "no estate path context"}). ` +
        "Settle it explicitly with a manifest declaration: `path_grammar: rpc_plain` or " +
        "`path_grammar: resource_grammar`.",
    });
  }

  return {
    grammar: {
      classification: measured.classification,
      basis: ADAPTER_LOWERED_KINDS.has(kind) ? "source_kind" : "estate_evidence",
      evidence,
    },
    diagnostics,
  };
}

/**
 * Whether the naming pass gets the estate-wide path context (which arms the
 * trailing-method re-homing rules A and C in `deriveNames`). This is the
 * classifier's whole cash value: a resource or plain-RPC grammar reads its
 * trailing CRUD-verb segments as methods; a dotted-RPC or adapter-lowered
 * grammar must not (the method name IS the operation's identity there). An
 * ambiguous estate falls back to the pre-classifier source-kind gate, so
 * declining to guess never changes an estate's names.
 */
export function estateContextEnabled(grammar: PathGrammar, kind: SourceKind): boolean {
  switch (grammar.classification) {
    case "resource_grammar":
    case "rpc_plain":
      return true;
    case "rpc_dotted":
    case "adapter_lowered":
      return false;
    case "ambiguous":
      return RESOURCE_PATH_KINDS.has(kind);
  }
}
