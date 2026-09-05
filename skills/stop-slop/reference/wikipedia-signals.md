# Wikipedia-derived signals

Source: Wikipedia's `Signs of AI writing` field guide maintained by WikiProject AI Cleanup.

Use this as evidence about recurring patterns, not as an authorship detector. Wikipedia explicitly describes the list as descriptive rather than prescriptive and warns that individual signs are not proof that text was AI-generated.

## What the system adopts

### Content-level smoothing

The strongest general principle is regression toward generic prose. Specific facts get replaced with broad importance claims, flattering descriptions, or vague significance.

Flag or inspect:

- significance and legacy inflation;
- broad-trend claims with no new evidence;
- notability language used instead of explaining what sources establish;
- superficial analysis appended with `-ing` clauses;
- advertisement or travel-guide tone;
- vague attribution to experts, reports, critics, or observers;
- stock `challenges -> future prospects` endings.

The repair is usually not a synonym swap. Restore the specific fact, source, limitation, mechanism, or consequence.

## Language patterns

Wikipedia documents several recurring constructions that also appear in developer and product prose:

- avoiding plain `is`, `are`, and `has` with `serves as`, `stands as`, `functions as`, `features`, or `offers`;
- negative parallelism such as `not just X, but Y`;
- forced groups of three;
- elegant variation, where the same technical noun is repeatedly renamed to avoid repetition;
- high density of stock AI vocabulary.

These are review signals. None is an automatic error in isolation.

## Formatting patterns

Useful strict-profile signals include:

- excessive title case in headings;
- mechanical bold emphasis;
- vertical lists with bold inline mini-headings;
- excessive em-dash rhythm;
- decorative emoji;
- unusual table use where prose would be simpler;
- inconsistent quotation-mark style;
- skipped heading levels;
- repeated thematic breaks before headings.

Formatting rules are context-sensitive. A README may legitimately use Markdown conventions that would be wrong in Wikipedia wikitext.

## Chatbot residue

These are high-confidence defects in standalone documents:

- `I hope this helps`;
- `Would you like me to...`;
- `Here is a template...`;
- knowledge-cutoff disclaimers;
- commentary about what was or was not found in sources;
- speculative gap-filling after such disclaimers;
- placeholder text left in citations or templates;
- internal model citation markup pasted into output.

The detector includes common leaked forms such as `contentReference[oaicite:...]`, `[oai_citation:...]`, `turn0search0`, `[attached_file:1]`, `ppl-ai-file-upload`, and `:::writing{...}`.

## Citation integrity

Wikipedia also identifies deeper failure modes that regex alone cannot validate:

- broken external links;
- invalid ISBNs;
- unresolved or unrelated DOIs;
- fabricated references;
- references that exist but do not support the claim;
- placeholder citation fields;
- search-tracking parameters copied into citations.

These belong in a future citation-verification pass, not the prose linter. The current system should flag obvious placeholders and leaked internal citation markup, then hand real citation validation to a network-aware verifier.

## What we deliberately do not copy as hard rules

Do not turn Wikipedia-specific advice into universal writing law.

Examples:

- Markdown is normal in developer documentation, even though it can be suspicious when pasted into Wikipedia wikitext.
- Em dashes are valid punctuation. Density and mismatch with the writer's normal style are the signal.
- Rule-of-three lists are common in human prose. Repetition is the useful signal.
- Passive voice is sometimes clearer when the actor is irrelevant.
- Curly quotes may be correct for a publication even if a repository prefers ASCII.

## System consequence

The linter separates three kinds of output:

- `high`: narrow defects or strong residue suitable for CI failure;
- `medium`: probable slop requiring review;
- `advisory`: stylistic or structural signals that need context.

The score is a review score, not an AI probability. Never report that a document was AI-generated from this detector alone.
