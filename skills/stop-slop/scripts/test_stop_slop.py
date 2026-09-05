#!/usr/bin/env python3
from pathlib import Path
import sys

SDK_DIR = Path(__file__).resolve().parents[1] / "sdk"
sys.path.insert(0, str(SDK_DIR))

from stop_slop import apply_safe_fixes, scan_text  # noqa: E402


def ids(text: str) -> set[str]:
    return {finding.rule_id for finding in scan_text(text, path="test.md")}


def test_high_confidence_patterns() -> None:
    assert "throat-clearing" in ids("Here's the thing: retries are disabled.")
    assert "faux-insight" in ids("What most people miss is the approval boundary.")
    assert "proof-laundering" in ids("One model means the files cannot drift.")
    assert "fake-profound-ending" in ids("The future isn't coming. It's already here.")


def test_medium_patterns() -> None:
    found = ids("This robust system empowers teams, underscoring our commitment to innovation.")
    assert "marketing-adjective" in found
    assert "fake-strong-verb" in found
    assert "superficial-analysis" in found


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


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
