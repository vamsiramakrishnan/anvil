#!/usr/bin/env python3
"""CLI for the stop-slop skill.

No third-party dependencies.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys

SDK_DIR = Path(__file__).resolve().parents[1] / "sdk"
sys.path.insert(0, str(SDK_DIR))

from stop_slop import apply_safe_fixes, findings_as_dicts, scan_path, score  # noqa: E402


SEVERITY_ORDER = {"advisory": 0, "medium": 1, "high": 2}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="slop", description="Find explainable AI-writing slop patterns.")
    sub = parser.add_subparsers(dest="command", required=True)

    for command in ("check", "explain"):
        p = sub.add_parser(command)
        p.add_argument("path")
        p.add_argument("--format", choices=("text", "json"), default="text")
        p.add_argument("--fail-on", choices=("none", "medium", "high"), default="high")
        p.add_argument("--include-advisory", action="store_true")

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
        print(f"{finding.path}:{finding.line} [{finding.severity}] {finding.rule_id}")
        print(f"  {finding.excerpt}")
        if explain:
            print(f"  Why: {finding.explanation}")
            print(f"  Change: {finding.action}")

    print(f"\n{len(findings)} finding(s), weighted score {score(findings)}")


def _run_scan(args: argparse.Namespace) -> int:
    severities = ("high", "medium", "advisory") if args.include_advisory else ("high", "medium")
    findings = scan_path(args.path, severities=severities)

    if args.format == "json":
        print(json.dumps({"score": score(findings), "findings": findings_as_dicts(findings)}, indent=2))
    else:
        _print_text(findings, explain=args.command == "explain")

    return 1 if _threshold_failed(findings, args.fail_on) else 0


def _run_fix(args: argparse.Namespace) -> int:
    path = Path(args.path)
    if not path.is_file():
        print("fix currently accepts one text file at a time", file=sys.stderr)
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
    if args.command == "fix":
        return _run_fix(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
