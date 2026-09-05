"""Deterministic, explainable checks for common AI-writing slop patterns.

This module does not detect AI authorship. It finds named writing patterns that are
useful review candidates.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path
import re
from typing import Iterable, Iterator, Sequence


SEVERITY_WEIGHT = {"high": 5, "medium": 2, "advisory": 1}
TEXT_EXTENSIONS = {".md", ".mdx", ".txt", ".rst", ".adoc"}


@dataclass(frozen=True)
class Rule:
    id: str
    severity: str
    pattern: re.Pattern[str]
    explanation: str
    action: str


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    rule_id: str
    severity: str
    match: str
    excerpt: str
    explanation: str
    action: str

    def to_dict(self) -> dict:
        return asdict(self)


RULES: tuple[Rule, ...] = (
    Rule(
        "throat-clearing",
        "high",
        re.compile(
            r"\b(?:here(?:'|’)s the thing|let me be clear|it(?:'|’)s (?:important|worth) to note|before we dive in|in today(?:'|’)s (?:world|fast-paced world))\b",
            re.IGNORECASE,
        ),
        "The sentence announces or frames the point instead of stating it.",
        "Delete the setup and lead with the claim.",
    ),
    Rule(
        "faux-insight",
        "high",
        re.compile(
            r"\b(?:what most people miss|what most teams miss|here(?:'|’)s what nobody tells you|the part everyone misses|the uncomfortable truth is|the subtle point is)\b",
            re.IGNORECASE,
        ),
        "The prose presents ordinary information as privileged insight.",
        "State the insight directly.",
    ),
    Rule(
        "narrator-certification",
        "high",
        re.compile(
            r"\b(?:the rule is (?:simple|direct|clear)|the result is (?:simple|clear)|the key point is|the takeaway is|this distinction matters|as you can see)\b",
            re.IGNORECASE,
        ),
        "The narrator certifies clarity or importance instead of adding information.",
        "Remove the certification and keep the rule, result, or distinction.",
    ),
    Rule(
        "binary-reveal",
        "medium",
        re.compile(
            r"\b(?:it|this|the question) (?:isn(?:'|’)t|is not)\b[^.!?]{1,120}[.!?]\s*(?:it|this) (?:is|is about)\b",
            re.IGNORECASE,
        ),
        "The sentence pair may manufacture contrast instead of stating the actual point.",
        "Keep the rejected alternative only if correcting it matters to the reader.",
    ),
    Rule(
        "colon-reveal",
        "medium",
        re.compile(
            r"\b(?:the best part|the reason|the secret|the answer|the trick|the catch)\s*:\s*",
            re.IGNORECASE,
        ),
        "The colon stages a reveal rather than serving a list, label, or definition.",
        "Rewrite as a declarative sentence.",
    ),
    Rule(
        "importance-puffery",
        "medium",
        re.compile(r"\b(?:pivotal|paramount|transformative|game[- ]changer|vital role|significant milestone|crucial distinction)\b", re.IGNORECASE),
        "The prose labels importance without supplying the evidence or consequence.",
        "Name the dependency, number, failure mode, or consequence.",
    ),
    Rule(
        "fake-strong-verb",
        "medium",
        re.compile(r"\b(?:empower(?:s|ed|ing)?|unlock(?:s|ed|ing)?|leverage(?:s|d|ing)?|harness(?:es|ed|ing)?|elevate(?:s|d|ing)?|showcase(?:s|d|ing)?|streamline(?:s|d|ing)?)\b", re.IGNORECASE),
        "A promotional verb may be standing in for a more exact operation.",
        "Prefer the concrete action when one exists.",
    ),
    Rule(
        "superficial-analysis",
        "medium",
        re.compile(r"\b(?:highlighting|underscoring|showcasing|demonstrating|reflecting)\b[^.!?]{0,100}\b(?:commitment|importance|dedication|focus|innovation|leadership|excellence)\b", re.IGNORECASE),
        "A trailing analysis clause adds a virtue claim rather than a mechanism or consequence.",
        "Delete the commentary or replace it with a concrete consequence.",
    ),
    Rule(
        "proof-laundering",
        "high",
        re.compile(r"\b(?:cannot|can(?:'|’)t) (?:drift|disagree|go stale)|\balways agrees?\b|\bsingle source of truth\b", re.IGNORECASE),
        "The prose may claim a stronger guarantee than the implementation or test proves.",
        "State the enforcement point, scope, timing, and residual failure mode.",
    ),
    Rule(
        "marketing-adjective",
        "medium",
        re.compile(r"\b(?:robust|seamless|enterprise-grade|production-ready|battle-tested|cutting-edge|powerful|intuitive|effortless|sophisticated)\b", re.IGNORECASE),
        "A praise adjective may be replacing an observable property.",
        "Replace it with behavior, evidence, or a measurable property.",
    ),
    Rule(
        "fake-profound-ending",
        "high",
        re.compile(r"\b(?:the future isn(?:'|’)t coming[.!?]\s*it(?:'|’)s already here|that(?:'|’)s the whole thing|and that(?:'|’)s the point|that(?:'|’)s it[.!?]\s*it(?:'|’)s that simple)\b", re.IGNORECASE),
        "The closing line optimizes for a mic-drop rather than information.",
        "End on the last concrete result or next action.",
    ),
    Rule(
        "summary-ending",
        "medium",
        re.compile(r"^\s*(?:in conclusion|to summarize|in summary|ultimately)\b", re.IGNORECASE),
        "The paragraph may recap material the reader just read.",
        "Delete the recap unless it adds a new decision or constraint.",
    ),
    Rule(
        "absolute-claim",
        "advisory",
        re.compile(r"\b(?:always|never|every|all|guaranteed|complete|exact|only)\b", re.IGNORECASE),
        "Absolute language should be scoped to the component, code path, or protocol that enforces it.",
        "Check the boundary. Keep the word when the guarantee is real and scoped.",
    ),
    Rule(
        "empty-transition",
        "medium",
        re.compile(r"\b(?:in practice, this means|put differently|in other words|here(?:'|’)s why that matters|so what does this buy you|what does this buy you)\b", re.IGNORECASE),
        "The transition often introduces a restatement rather than new information.",
        "Delete it and keep only the new consequence, if any.",
    ),
)


SAFE_FIXES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bin order to\b", re.IGNORECASE), "to"),
    (re.compile(r"\bdue to the fact that\b", re.IGNORECASE), "because"),
    (re.compile(r"\bhas the ability to\b", re.IGNORECASE), "can"),
    (re.compile(r"\bhave the ability to\b", re.IGNORECASE), "can"),
)


def _masked_lines(text: str) -> Iterator[tuple[int, str]]:
    """Yield source line numbers while hiding frontmatter and fenced code."""
    in_fence = False
    in_frontmatter = False
    frontmatter_possible = True

    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()

        if number == 1 and stripped == "---":
            in_frontmatter = True
            yield number, ""
            continue

        if in_frontmatter:
            if stripped == "---":
                in_frontmatter = False
                frontmatter_possible = False
            yield number, ""
            continue

        if frontmatter_possible and stripped:
            frontmatter_possible = False

        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            yield number, ""
            continue

        if in_fence:
            yield number, ""
            continue

        # Preserve visible prose and line numbers. Mask inline code and URLs.
        visible = re.sub(r"`[^`]*`", "", line)
        visible = re.sub(r"https?://\S+", "", visible)
        yield number, visible


def scan_text(text: str, *, path: str = "<memory>", severities: Sequence[str] | None = None) -> list[Finding]:
    allowed = set(severities or SEVERITY_WEIGHT)
    findings: list[Finding] = []

    for line_number, line in _masked_lines(text):
        if not line.strip():
            continue
        for rule in RULES:
            if rule.severity not in allowed:
                continue
            for match in rule.pattern.finditer(line):
                findings.append(
                    Finding(
                        path=path,
                        line=line_number,
                        rule_id=rule.id,
                        severity=rule.severity,
                        match=match.group(0),
                        excerpt=line.strip()[:240],
                        explanation=rule.explanation,
                        action=rule.action,
                    )
                )
    return findings


def score(findings: Iterable[Finding]) -> int:
    return sum(SEVERITY_WEIGHT[f.severity] for f in findings)


def iter_text_files(path: Path) -> Iterator[Path]:
    if path.is_file():
        if path.suffix.lower() in TEXT_EXTENSIONS or path.name.lower() == "readme":
            yield path
        return

    for candidate in sorted(path.rglob("*")):
        if not candidate.is_file():
            continue
        if any(part in {".git", "node_modules", "dist", "build", ".next", ".venv", "venv"} for part in candidate.parts):
            continue
        if candidate.suffix.lower() in TEXT_EXTENSIONS:
            yield candidate


def scan_path(path: str | Path, *, severities: Sequence[str] | None = None) -> list[Finding]:
    root = Path(path)
    findings: list[Finding] = []
    for file_path in iter_text_files(root):
        try:
            text = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        findings.extend(scan_text(text, path=str(file_path), severities=severities))
    return findings


def apply_safe_fixes(text: str) -> tuple[str, int]:
    """Apply narrow wording simplifications that do not need domain knowledge."""
    changed = text
    count = 0
    for pattern, replacement in SAFE_FIXES:
        changed, n = pattern.subn(replacement, changed)
        count += n
    return changed, count


def findings_as_dicts(findings: Iterable[Finding]) -> list[dict]:
    return [finding.to_dict() for finding in findings]
