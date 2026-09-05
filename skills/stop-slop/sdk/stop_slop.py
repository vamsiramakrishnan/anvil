"""Explainable checks for common AI-writing patterns.

This module does not guess whether text was written by AI. It finds named patterns
that are useful review candidates. Rules are split by confidence so CI can fail on
narrow signals without turning style preferences into grammar laws.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path
import re
from typing import Iterable, Iterator, Sequence


SEVERITY_WEIGHT = {"high": 5, "medium": 2, "advisory": 1}
TEXT_EXTENSIONS = {".md", ".mdx", ".txt", ".rst", ".adoc"}
DEFAULT_EXCLUDES = {".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "vendor"}


@dataclass(frozen=True)
class Rule:
    id: str
    severity: str
    category: str
    pattern: re.Pattern[str]
    explanation: str
    action: str
    profiles: frozenset[str] = frozenset({"general", "technical", "strict"})


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    column: int
    rule_id: str
    severity: str
    category: str
    match: str
    excerpt: str
    explanation: str
    action: str

    def to_dict(self) -> dict:
        return asdict(self)


P = frozenset
RULES: tuple[Rule, ...] = (
    Rule(
        "throat-clearing", "high", "metadiscourse",
        re.compile(r"\b(?:here(?:'|’)s the thing|let me be clear|it(?:'|’)s (?:important|worth) to note|before we dive in|in today(?:'|’)s (?:world|fast-paced world)|at its core|when it comes to)\b", re.I),
        "The sentence frames the point instead of stating it.",
        "Delete the setup and lead with the claim.",
    ),
    Rule(
        "faux-insight", "high", "metadiscourse",
        re.compile(r"\b(?:what most people miss|what most teams miss|here(?:'|’)s what nobody tells you|the part everyone misses|the uncomfortable truth is|the subtle point is|the interesting part is)\b", re.I),
        "The prose presents ordinary information as privileged insight.",
        "State the insight directly.",
    ),
    Rule(
        "narrator-certification", "high", "metadiscourse",
        re.compile(r"\b(?:the rule is (?:simple|direct|clear)|the result is (?:simple|clear)|the key point is|the takeaway is|this distinction matters|as you can see|the consequence is concrete)\b", re.I),
        "The narrator certifies clarity or importance instead of adding information.",
        "Remove the certification and keep the rule, result, or distinction.",
    ),
    Rule(
        "chatbot-residue", "high", "chatbot",
        re.compile(r"\b(?:i hope this helps|of course!|certainly!|you(?:'|’)re absolutely right|would you like me to|want me to (?:continue|give examples)|let me know if you(?:'|’)d like|here is a (?:template|draft|breakdown))\b", re.I),
        "Assistant-facing language leaked into standalone prose.",
        "Delete the chatbot wrapper and keep the content.",
    ),
    Rule(
        "knowledge-cutoff-disclaimer", "high", "chatbot",
        re.compile(r"\b(?:up to my last training update|as of my last knowledge update|based on available information|in the (?:provided|available) sources|specific details are (?:limited|scarce)|not widely (?:available|documented|disclosed))\b", re.I),
        "The prose exposes model limitations or source-search commentary instead of stating the supported fact.",
        "State what the source establishes. Remove speculation used to fill the gap.",
    ),
    Rule(
        "placeholder-text", "high", "chatbot",
        re.compile(r"\b(?:insert_source_url|source_publisher|paste_[a-z0-9_]+_url_here|yyyy-mm-xx|20\d\d-xx-xx)\b", re.I),
        "Template placeholder text appears in user-facing prose or citations.",
        "Replace it with verified content or remove the incomplete block.",
    ),
    Rule(
        "model-markup-leak", "high", "markup",
        re.compile(r"(?:contentReference\[oaicite:|\[oai_citation:|turn\d+(?:search|news|file|image)\d+|\[attached_file:\d+\]|ppl-ai-file-upload|:::writing\{|\[cite:\s*\d+\]|\[span_\d+\])", re.I),
        "Internal model or product markup leaked into the document.",
        "Remove the artifact and restore a real citation or plain text.",
        P({"general", "technical", "strict"}),
    ),
    Rule(
        "vague-attribution", "high", "evidence",
        re.compile(r"\b(?:experts (?:agree|argue|believe)|industry reports (?:show|suggest|indicate)|observers have cited|studies show|widely regarded as|many teams find|critics argue|some observers say)\b", re.I),
        "The claim appeals to an unnamed authority.",
        "Name the source or remove the attribution.",
    ),
    Rule(
        "notability-proof", "medium", "evidence",
        re.compile(r"\b(?:independent coverage|regional media outlets|national media outlets|trade publications|profiled in|active social media presence|widely-read outlets)\b", re.I),
        "The prose may be using coverage labels as a proxy for explaining what the sources establish.",
        "State the sourced fact or contribution instead of rehearsing notability language.",
        P({"general", "strict"}),
    ),
    Rule(
        "proof-laundering", "high", "evidence",
        re.compile(r"\b(?:cannot|can(?:'|’)t) (?:drift|disagree|go stale)|\balways agrees?\b|\bsingle source of truth\b", re.I),
        "The prose may claim a stronger guarantee than the implementation or test proves.",
        "State the enforcement point, scope, timing, and residual failure mode.",
        P({"technical", "strict"}),
    ),
    Rule(
        "binary-reveal", "medium", "structure",
        re.compile(r"\b(?:it|this|the question) (?:isn(?:'|’)t|is not)\b[^.!?\n]{1,140}[.!?]\s*(?:it|this) (?:is|is about)\b", re.I),
        "The sentence pair may manufacture contrast instead of stating the actual point.",
        "Keep the rejected alternative only if correcting it matters to the reader.",
    ),
    Rule(
        "not-just-but", "medium", "structure",
        re.compile(r"\b(?:not (?:just|only|merely)\b[^.!?\n]{1,120}\bbut\b|rather than\b[^.!?\n]{1,120}\b(?:is|are|was|were)\b)", re.I),
        "A stock contrast may be adding cadence rather than information.",
        "State the positive claim directly unless the contrast corrects a real misconception.",
    ),
    Rule(
        "colon-reveal", "medium", "structure",
        re.compile(r"\b(?:the best part|the reason|the secret|the answer|the trick|the catch|the important part)\s*:\s*", re.I),
        "The colon stages a reveal rather than serving a list, label, or definition.",
        "Rewrite as a declarative sentence.",
    ),
    Rule(
        "forced-triad", "advisory", "rhythm",
        re.compile(r"\b\w+(?:,\s+\w+){2}\s+(?:and|or)\s+\w+\b"),
        "Groups of three are common and often valid, but repeated triads can create generated rhythm.",
        "Keep the list if all items are needed. Do not optimize item count for cadence.",
        P({"strict"}),
    ),
    Rule(
        "importance-puffery", "medium", "claim-quality",
        re.compile(r"\b(?:pivotal|paramount|transformative|game[- ]changer|vital role|significant milestone|crucial distinction|indelible mark|evolving landscape|lasting legacy|broader trend|focal point|setting the stage)\b", re.I),
        "The prose labels importance without supplying the evidence or consequence.",
        "Name the dependency, number, failure mode, or consequence.",
    ),
    Rule(
        "sales-language", "medium", "claim-quality",
        re.compile(r"\b(?:breathtaking|must-visit|renowned|stunning|groundbreaking|rich cultural heritage|in the heart of|nestled (?:in|within)|boasts? a|diverse array|refined dynamism|immersive experience)\b", re.I),
        "The sentence uses promotional language where a factual description would be clearer.",
        "Replace the praise with the observable property or fact.",
        P({"general", "strict"}),
    ),
    Rule(
        "copula-avoidance", "medium", "word-choice",
        re.compile(r"\b(?:serves as|stands as|functions as|operates as|represents a|marks a|boasts|offers a|features a)\b", re.I),
        "The sentence may be avoiding a simpler copula or possession verb.",
        "Try is, are, or has. Keep the longer verb only when it adds meaning.",
    ),
    Rule(
        "fake-strong-verb", "medium", "word-choice",
        re.compile(r"\b(?:empower(?:s|ed|ing)?|unlock(?:s|ed|ing)?|leverage(?:s|d|ing)?|harness(?:es|ed|ing)?|elevate(?:s|d|ing)?|showcase(?:s|d|ing)?|streamline(?:s|d|ing)?|facilitate(?:s|d|ing)?)\b", re.I),
        "A promotional verb may be standing in for a more exact operation.",
        "Prefer the concrete action when one exists.",
    ),
    Rule(
        "superficial-analysis", "medium", "claim-quality",
        re.compile(r"\b(?:highlighting|underscoring|showcasing|demonstrating|reflecting|symbolizing|emphasizing|ensuring|contributing to|fostering|cultivating|enhancing)\b[^.!?\n]{0,140}\b(?:commitment|importance|dedication|focus|innovation|leadership|excellence|connection|significance|relevance|impact)\b", re.I),
        "A trailing analysis clause adds a virtue or significance claim rather than a mechanism or consequence.",
        "Delete the commentary or replace it with a concrete consequence.",
    ),
    Rule(
        "marketing-adjective", "medium", "word-choice",
        re.compile(r"\b(?:robust|seamless|enterprise-grade|production-ready|battle-tested|cutting-edge|powerful|intuitive|effortless|sophisticated|vibrant|profound|valuable|intricate|meticulous)\b", re.I),
        "A praise adjective may be replacing an observable property.",
        "Replace it with behavior, evidence, or a measurable property.",
    ),
    Rule(
        "formulaic-outlook", "medium", "structure",
        re.compile(r"\bdespite (?:these|its) challenges\b[^.!?\n]{0,180}\b(?:future|continues? to|positions? (?:it|them)|broader adoption|next-generation)\b", re.I),
        "The sentence uses a stock challenges-to-future-prospects arc.",
        "Keep only the documented limitation, planned action, or forecast.",
        P({"general", "strict"}),
    ),
    Rule(
        "inline-header-list", "advisory", "formatting",
        re.compile(r"^\s*(?:[-*+] |\d+\.\s+)\*\*[^*]{1,80}\*\*\s*:\s+"),
        "Bold mini-headings inside vertical lists are a common chatbot formatting pattern.",
        "Use prose, a real heading, or a table when that better matches the information structure.",
        P({"strict"}),
    ),
    Rule(
        "thematic-break-before-heading", "advisory", "formatting",
        re.compile(r"^\s*(?:---|\*\*\*|___)\s*$"),
        "Repeated thematic breaks before headings can be template-like formatting residue.",
        "Keep a break only when it marks a real section boundary.",
        P({"strict"}),
    ),
    Rule(
        "em-dash-density", "advisory", "rhythm",
        re.compile(r"—"),
        "Em dashes are valid punctuation, but repeated use can create stock generated rhythm.",
        "Compare with the writer's normal punctuation. Do not remove a dash mechanically.",
        P({"strict"}),
    ),
    Rule(
        "fake-profound-ending", "high", "ending",
        re.compile(r"\b(?:the future isn(?:'|’)t coming[.!?]\s*it(?:'|’)s already here|that(?:'|’)s the whole thing|and that(?:'|’)s the point|that(?:'|’)s it[.!?]\s*it(?:'|’)s that simple)\b", re.I),
        "The closing line optimizes for a mic-drop rather than information.",
        "End on the last concrete result or next action.",
    ),
    Rule(
        "summary-ending", "medium", "ending",
        re.compile(r"^\s*(?:in conclusion|to summarize|in summary|ultimately|overall)\b", re.I),
        "The paragraph may recap material the reader just read.",
        "Delete the recap unless it adds a new decision or constraint.",
    ),
    Rule(
        "absolute-claim", "advisory", "claim-quality",
        re.compile(r"\b(?:always|never|every|all|guaranteed|complete|exact|only)\b", re.I),
        "Absolute language should be scoped to the component, code path, or protocol that enforces it.",
        "Check the boundary. Keep the word when the guarantee is real and scoped.",
    ),
    Rule(
        "empty-transition", "medium", "metadiscourse",
        re.compile(r"\b(?:in practice, this means|put differently|in other words|here(?:'|’)s why that matters|so what does this buy you|what does this buy you)\b", re.I),
        "The transition often introduces a restatement rather than new information.",
        "Delete it and keep only the new consequence, if any.",
    ),
    Rule(
        "false-range", "advisory", "structure",
        re.compile(r"\bfrom\s+[^,.!?\n]{2,80}\s+to\s+[^,.!?\n]{2,80}\b", re.I),
        "From-to phrasing can imply an ordered range where none exists.",
        "Keep it for a real range. Otherwise list the topics directly.",
        P({"strict"}),
    ),
)


SAFE_FIXES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bin order to\b", re.I), "to"),
    (re.compile(r"\bdue to the fact that\b", re.I), "because"),
    (re.compile(r"\bhas the ability to\b", re.I), "can"),
    (re.compile(r"\bhave the ability to\b", re.I), "can"),
)


def get_rules(*, profile: str = "technical", severities: Sequence[str] | None = None) -> tuple[Rule, ...]:
    if profile not in {"general", "technical", "strict"}:
        raise ValueError(f"unknown profile: {profile}")
    allowed = set(severities or SEVERITY_WEIGHT)
    return tuple(rule for rule in RULES if profile in rule.profiles and rule.severity in allowed)


def _mask_inline(line: str) -> str:
    line = re.sub(r"`[^`]*`", lambda m: " " * len(m.group(0)), line)
    line = re.sub(r"https?://\S+", lambda m: " " * len(m.group(0)), line)
    return line


def _masked_lines(text: str) -> Iterator[tuple[int, str]]:
    """Yield source line numbers while hiding frontmatter and fenced code.

    The masking keeps character offsets stable, so reported columns still map to the
    original line. Model-markup checks happen before URL masking at the line level.
    """
    in_fence = False
    in_frontmatter = False

    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()

        if number == 1 and stripped == "---":
            in_frontmatter = True
            yield number, " " * len(line)
            continue

        if in_frontmatter:
            if stripped == "---":
                in_frontmatter = False
            yield number, " " * len(line)
            continue

        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            yield number, " " * len(line)
            continue

        if in_fence or "slop: ignore-line" in line:
            yield number, " " * len(line)
            continue

        yield number, _mask_inline(line)


def scan_text(
    text: str,
    *,
    path: str = "<memory>",
    severities: Sequence[str] | None = None,
    profile: str = "technical",
    disabled_rules: Sequence[str] = (),
) -> list[Finding]:
    disabled = set(disabled_rules)
    rules = [rule for rule in get_rules(profile=profile, severities=severities) if rule.id not in disabled]
    findings: list[Finding] = []

    for line_number, line in _masked_lines(text):
        if not line.strip():
            continue
        for rule in rules:
            for match in rule.pattern.finditer(line):
                findings.append(Finding(
                    path=path,
                    line=line_number,
                    column=match.start() + 1,
                    rule_id=rule.id,
                    severity=rule.severity,
                    category=rule.category,
                    match=match.group(0),
                    excerpt=line.strip()[:240],
                    explanation=rule.explanation,
                    action=rule.action,
                ))
    return findings


def score(findings: Iterable[Finding]) -> int:
    return sum(SEVERITY_WEIGHT[f.severity] for f in findings)


def density(findings: Iterable[Finding], *, word_count: int) -> float:
    """Weighted findings per 1,000 words. This is a review metric, not an AI probability."""
    if word_count <= 0:
        return 0.0
    return round(score(findings) * 1000 / word_count, 2)


def iter_text_files(path: Path, *, excludes: Sequence[str] = ()) -> Iterator[Path]:
    excluded = DEFAULT_EXCLUDES | set(excludes)
    if path.is_file():
        if path.suffix.lower() in TEXT_EXTENSIONS or path.name.lower() == "readme":
            yield path
        return

    for candidate in sorted(path.rglob("*")):
        if not candidate.is_file():
            continue
        if any(part in excluded for part in candidate.parts):
            continue
        if candidate.suffix.lower() in TEXT_EXTENSIONS:
            yield candidate


def scan_path(
    path: str | Path,
    *,
    severities: Sequence[str] | None = None,
    profile: str = "technical",
    disabled_rules: Sequence[str] = (),
    excludes: Sequence[str] = (),
) -> list[Finding]:
    root = Path(path)
    findings: list[Finding] = []
    for file_path in iter_text_files(root, excludes=excludes):
        try:
            text = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        findings.extend(scan_text(text, path=str(file_path), severities=severities, profile=profile, disabled_rules=disabled_rules))
    return findings


def apply_safe_fixes(text: str) -> tuple[str, int]:
    """Apply wording simplifications that do not need domain knowledge."""
    changed = text
    count = 0
    for pattern, replacement in SAFE_FIXES:
        changed, n = pattern.subn(replacement, changed)
        count += n
    return changed, count


def findings_as_dicts(findings: Iterable[Finding]) -> list[dict]:
    return [finding.to_dict() for finding in findings]


def rules_as_dicts(*, profile: str = "technical") -> list[dict]:
    return [
        {
            "id": rule.id,
            "severity": rule.severity,
            "category": rule.category,
            "explanation": rule.explanation,
            "action": rule.action,
        }
        for rule in get_rules(profile=profile)
    ]
