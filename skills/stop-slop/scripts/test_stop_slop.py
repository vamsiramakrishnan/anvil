#!/usr/bin/env python3
from pathlib import Path
import sys

SDK_DIR = Path(__file__).resolve().parents[1] / "sdk"
sys.path.insert(0, str(SDK_DIR))

from stop_slop import apply_safe_fixes, get_rules, scan_text  # noqa: E402


def ids(text: str, *, profile: str = "technical") -> set[str]:
    return {finding.rule_id for finding in scan_text(text, path="test.md", profile=profile)}


def test_high_confidence_patterns() -> None:
    assert "throat-clearing" in ids("Here's the thing: retries are disabled.")
    assert "faux-insight" in ids("What most people miss is the approval boundary.")
    assert "proof-laundering" in ids("One model means the files cannot drift.")
    assert "fake-profound-ending" in ids("The future isn't coming. It's already here.")
    assert "chatbot-residue" in ids("I hope this helps. Let me know if you'd like more detail.")
    assert "vague-attribution" in ids("Industry reports suggest this is safer.")


def test_medium_patterns() -> None:
    found = ids("This robust system empowers teams, underscoring our commitment to innovation.")
    assert "marketing-adjective" in found
    assert "fake-strong-verb" in found
    assert "superficial-analysis" in found
    assert "not-just-but" in ids("It is not just a wrapper but a complete platform.")


def test_general_profile_gets_sales_language_but_not_technical_proof_rule() -> None:
    assert "sales-language" in ids("Nestled in the heart of town, it is a stunning venue.", profile="general")
    assert "proof-laundering" not in ids("The files cannot drift.", profile="general")


def test_strict_profile_adds_advisory_structure_checks() -> None:
    rule_ids = {rule.id for rule in get_rules(profile="strict")}
    assert "forced-triad" in rule_ids
    assert "false-range" in rule_ids


def test_code_and_frontmatter_are_masked_without_losing_line_numbers() -> None:
    text = """---
title: Here's the thing
---
Normal line.
```md
What most people miss
```
The rule is simple: fail closed.
"""
    findings = scan_text(text, path="doc.md")
    assert len(findings) == 1
    assert findings[0].rule_id == "narrator-certification"
    assert findings[0].line == 8
    assert findings[0].column == 1


def test_inline_code_and_urls_are_masked() -> None:
    assert not ids("Run `echo Here's the thing` to inspect it.")
    assert not ids("See https://example.com/heres-the-thing for details.")


def test_ignore_line_escape_hatch() -> None:
    assert not ids("Here's the thing. <!-- slop: ignore-line -->")


def test_precise_adverbs_are_not_flagged() -> None:
    assert not ids("The runtime retries automatically after a 503.")
    assert not ids("Workers execute concurrently.")
    assert not ids("The parser fails deterministically on invalid input.")


def test_safe_fixes_are_narrow() -> None:
    source = "In order to retry due to the fact that the node failed, the client has the ability to resume."
    fixed, count = apply_safe_fixes(source)
    assert count == 3
    assert fixed == "to retry because the node failed, the client can resume."


def test_technical_absolute_is_advisory_only() -> None:
    findings = scan_text("The command always exits 0 here.", path="doc.md")
    absolute = [f for f in findings if f.rule_id == "absolute-claim"]
    assert len(absolute) == 1
    assert absolute[0].severity == "advisory"


def test_rule_can_be_disabled() -> None:
    findings = scan_text(
        "This robust system is production-ready.",
        path="doc.md",
        disabled_rules=["marketing-adjective"],
    )
    assert not findings


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
