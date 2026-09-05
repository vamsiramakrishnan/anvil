# SDK

The Python SDK exposes the same deterministic rules used by the CLI.

No third-party package is required.

## Scan text

```python
from pathlib import Path
import sys

sys.path.insert(0, "skills/stop-slop/sdk")
from stop_slop import scan_text, score

text = Path("README.md").read_text()
findings = scan_text(text, path="README.md")

for finding in findings:
    print(finding.line, finding.rule_id, finding.severity, finding.match)

print("score", score(findings))
```

## Scan a path

```python
from stop_slop import scan_path

findings = scan_path(
    "apps/docs/src/content/docs",
    severities=("high", "medium"),
)
```

## JSON integration

```python
import json
from stop_slop import findings_as_dicts, scan_path, score

findings = scan_path("README.md")
payload = {
    "score": score(findings),
    "findings": findings_as_dicts(findings),
}
print(json.dumps(payload, indent=2))
```

## Safe fixes

```python
from stop_slop import apply_safe_fixes

updated, changes = apply_safe_fixes(text)
```

`apply_safe_fixes` only performs narrow phrase simplifications. It does not attempt semantic rewriting.

## Add a repository-specific rule

The built-in rule set is intentionally small. For project-specific enforcement, import `Rule` and append rules in a wrapper instead of editing the generic skill.

```python
import re
from stop_slop import Rule

RULE = Rule(
    id="project-slogan",
    severity="high",
    pattern=re.compile(r"one contract[.] every surface[.]", re.I),
    explanation="Project-specific slogan that obscures the generated-surface boundary.",
    action="Name the generated surfaces or the invariant directly.",
)
```

For a reusable extension, expose your own `scan_text` wrapper and keep repository rules separate from the shared catalog.

## Policy guidance

Use the SDK to find candidates, not infer authorship.

Good automation:

- fail on narrow high-confidence phrases;
- report medium patterns for review;
- compare changed lines;
- emit rule ids and line numbers;
- allow explicit, reasoned suppressions.

Bad automation:

- reject prose because an aggregate score exceeds an arbitrary number;
- claim the score measures whether text was written by AI;
- auto-rewrite technical claims;
- fail CI on passive voice, adverbs, sentence length, or em dashes alone.
