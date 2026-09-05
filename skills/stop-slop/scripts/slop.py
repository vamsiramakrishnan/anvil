#!/usr/bin/env python3
"""CLI for the stop-slop skill."""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import shutil
import sys

SDK_DIR = Path(__file__).resolve().parents[1] / "sdk"
sys.path.insert(0, str(SDK_DIR))

from stop_slop import (  # noqa: E402
    apply_safe_fixes,
    findings_as_dicts,
    rules_as_dicts,
    scan_path,
    score,
)


SEVERITY_ORDER = {"advisory": 0, "medium": 1, "high": 2}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="slop", description="Find named AI-writing patterns without guessing authorship.")
    sub = parser.add_subparsers(dest="command", required=True)

    for command in ("check", "explain"):
        p = sub.add_parser(command)
        p.add_argument("path")
        p.add_argument("--format", choices=("text", "json", "sarif"), default="text")
        p.add_argument("--fail-on", choices=("none", "medium", "high"), default="high")
        p.add_argument("--include-advisory", action="store_true")
        p.add_argument("--profile", choices=("general", "technical", "strict"), default="technical")
        p.add_argument("--disable-rule", action="append", default=[], help="Rule id to suppress. Repeat as needed.")
        p.add_argument("--exclude", action="append", default=[], help="Directory name to skip. Repeat as needed.")

    rules = sub.add_parser("rules", help="List the active rule catalog.")
    rules.add_argument("--profile", choices=("general", "technical", "strict"), default="technical")
    rules.add_argument("--format", choices=("text", "json"), default="text")

    fix = sub.add_parser("fix")
    fix.add_argument("path")
    fix.add_argument("--apply", action="store_true", help="Write changes. Without this flag, print a preview summary only.")
    fix.add_argument("--backup", action="store_true", help="Create <file>.backup before writing.")

    return parser.parse_args()


def _threshold_failed(findings, fail_on: str) -> bool:
    if fail_on == "none":
        return False
    threshold = SEVERITY_ORDER[fail_on]
    return any(SEVERITY_ORDER[f.severity] >= threshold for f in findings)


def _print_text(findings, explain: bool) -> None:
    if not findings:
        print("No findings.")
        return

    for finding in findings:
        print(f"{finding.path}:{finding.line}:{finding.column} [{finding.severity}] {finding.rule_id}")
        print(f"  {finding.excerpt}")
        if explain:
            print(f"  Why: {finding.explanation}")
            print(f"  Change: {finding.action}")

    by_severity = Counter(f.severity for f in findings)
    parts = ", ".join(f"{name}={by_severity[name]}" for name in ("high", "medium", "advisory") if by_severity[name])
    print(f"\n{len(findings)} finding(s), weighted review score {score(findings)} ({parts})")


def _to_sarif(findings) -> dict:
    rule_ids = sorted({f.rule_id for f in findings})
    catalog = {r["id"]: r for r in rules_as_dicts(profile="strict")}
    rules = []
    for rule_id in rule_ids:
        rule = catalog.get(rule_id, {"id": rule_id, "explanation": rule_id, "action": "Review the finding."})
        rules.append({
            "id": rule_id,
            "shortDescription": {"text": rule["explanation"]},
            "help": {"text": rule["action"]},
        })

    return {
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {"driver": {"name": "stop-slop", "rules": rules}},
            "results": [
                {
                    "ruleId": f.rule_id,
                    "level": "error" if f.severity == "high" else "warning" if f.severity == "medium" else "note",
                    "message": {"text": f"{f.explanation} Suggested action: {f.action}"},
                    "locations": [{
                        "physicalLocation": {
                            "artifactLocation": {"uri": f.path},
                            "region": {"startLine": f.line, "startColumn": f.column},
                        }
                    }],
                }
                for f in findings
            ],
        }],
    }


def _run_scan(args: argparse.Namespace) -> int:
    severities = ("high", "medium", "advisory") if args.include_advisory else ("high", "medium")
    findings = scan_path(
        args.path,
        severities=severities,
        profile=args.profile,
        disabled_rules=args.disable_rule,
        excludes=args.exclude,
    )

    if args.format == "json":
        print(json.dumps({
            "profile": args.profile,
            "score": score(findings),
            "findings": findings_as_dicts(findings),
        }, indent=2))
    elif args.format == "sarif":
        print(json.dumps(_to_sarif(findings), indent=2))
    else:
        _print_text(findings, explain=args.command == "explain")

    return 1 if _threshold_failed(findings, args.fail_on) else 0


def _run_rules(args: argparse.Namespace) -> int:
    rules = rules_as_dicts(profile=args.profile)
    if args.format == "json":
        print(json.dumps({"profile": args.profile, "rules": rules}, indent=2))
        return 0

    for rule in rules:
        print(f"{rule['id']:<24} {rule['severity']:<8} {rule['category']}")
    return 0


def _run_fix(args: argparse.Namespace) -> int:
    path = Path(args.path)
    if not path.is_file():
        print("fix accepts one text file at a time", file=sys.stderr)
        return 2

    original = path.read_text(encoding="utf-8")
    updated, count = apply_safe_fixes(original)

    if count == 0:
        print("No safe fixes available.")
        return 0

    if not args.apply:
        print(f"{count} safe fix(es) available. Re-run with --apply to write them.")
        return 0

    if args.backup:
        shutil.copyfile(path, path.with_name(path.name + ".backup"))

    path.write_text(updated, encoding="utf-8")
    print(f"Applied {count} safe fix(es) to {path}.")
    return 0


def main() -> int:
    args = _parse_args()
    if args.command in {"check", "explain"}:
        return _run_scan(args)
    if args.command == "rules":
        return _run_rules(args)
    if args.command == "fix":
        return _run_fix(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
