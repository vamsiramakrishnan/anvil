# CLI

The CLI scans Markdown and plain-text documentation without external dependencies.

## Check

```bash
python skills/stop-slop/scripts/slop.py check README.md
```

Default behavior:

- scans high- and medium-confidence rules;
- ignores fenced code, YAML front matter, inline code, and URLs;
- preserves source line numbers;
- exits `1` when a high-severity finding exists;
- exits `0` otherwise.

Scan a directory:

```bash
python skills/stop-slop/scripts/slop.py check apps/docs/src/content/docs
```

Include advisory rules:

```bash
python skills/stop-slop/scripts/slop.py check README.md --include-advisory
```

Change the failure threshold:

```bash
python skills/stop-slop/scripts/slop.py check README.md --fail-on medium
python skills/stop-slop/scripts/slop.py check README.md --fail-on none
```

## Explain

Use `explain` during review. It prints why each rule matched and what kind of change to consider.

```bash
python skills/stop-slop/scripts/slop.py explain README.md
```

## JSON output

```bash
python skills/stop-slop/scripts/slop.py check README.md --format json
```

Shape:

```json
{
  "score": 7,
  "findings": [
    {
      "path": "README.md",
      "line": 42,
      "rule_id": "faux-insight",
      "severity": "high",
      "match": "What most people miss",
      "excerpt": "What most people miss is ...",
      "explanation": "...",
      "action": "State the insight directly."
    }
  ]
}
```

## Safe fixes

The fixer is deliberately narrow.

Preview:

```bash
python skills/stop-slop/scripts/slop.py fix README.md
```

Apply:

```bash
python skills/stop-slop/scripts/slop.py fix README.md --apply --backup
```

Current safe fixes:

- `in order to` -> `to`;
- `due to the fact that` -> `because`;
- `has the ability to` -> `can`;
- `have the ability to` -> `can`.

The fixer does not rewrite claims, remove adjectives blindly, convert passive voice, or change absolutes.

## CI

A conservative CI check:

```yaml
- name: Check documentation slop
  run: python skills/stop-slop/scripts/slop.py check . --fail-on high
```

For an established repository, prefer changed-line gating so old findings do not block unrelated work. Treat medium findings as review prompts until the team has measured false positives.
