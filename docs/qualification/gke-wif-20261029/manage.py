"""Create or remove only the reviewed live-qualification resources."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(os.environ["ANVIL_WIF_RECORD_DIR"])
PROJECT = os.environ["ANVIL_WIF_PROJECT"]
NAMESPACE = "by-atomic-wif-20261029"
BUCKET = f"{PROJECT}-by-wif-20261029"
KUBECONFIG = os.environ["KUBECONFIG"]
os.environ["KUBECONFIG"] = KUBECONFIG
STATE = ROOT / "resources.json"
state = (
    json.loads(STATE.read_text()) if STATE.exists() else {"created": [], "accounts": {}}
)


def run(args, label, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    (ROOT / f"{label}.log").write_text(result.stdout + result.stderr)
    print(json.dumps({"step": label, "exit": result.returncode}), flush=True)
    if check and result.returncode:
        raise RuntimeError(f"{label} failed; inspect its redacted resource-command log")
    return result


def save():
    STATE.write_text(json.dumps(state, indent=2) + "\n")


def create():
    if state["created"]:
        raise RuntimeError("Resources already recorded; do not repeat creation")
    run(["kubectl", "create", "namespace", NAMESPACE], "create-namespace")
    state["created"].append("namespace")
    save()
    run(
        [
            "kubectl",
            "label",
            "namespace",
            NAMESPACE,
            "purpose=branchyard-wif-validation",
            "validation-date=20261029",
        ],
        "label-namespace",
    )
    for role in ["allow", "deny"]:
        name = f"by-wif-{role}-20261029"
        result = run(
            [
                "gcloud",
                "iam",
                "service-accounts",
                "create",
                name,
                f"--project={PROJECT}",
                "--display-name=Temporary Branchyard WIF qualification",
                "--format=json(email,uniqueId)",
            ],
            f"create-sa-{role}",
        )
        state["accounts"][role] = json.loads(result.stdout)
        state["created"].append(f"sa-{role}")
        save()
        ksa = f"{role}-20261029"
        run(
            ["kubectl", "-n", NAMESPACE, "create", "serviceaccount", ksa],
            f"create-ksa-{role}",
        )
        run(
            [
                "gcloud",
                "iam",
                "service-accounts",
                "add-iam-policy-binding",
                state["accounts"][role]["email"],
                f"--project={PROJECT}",
                "--role=roles/iam.workloadIdentityUser",
                f"--member=serviceAccount:{PROJECT}.svc.id.goog[{NAMESPACE}/{ksa}]",
                "--quiet",
            ],
            f"bind-wif-{role}",
        )
        run(
            [
                "kubectl",
                "-n",
                NAMESPACE,
                "annotate",
                "serviceaccount",
                ksa,
                f"iam.gke.io/gcp-service-account={state['accounts'][role]['email']}",
            ],
            f"annotate-ksa-{role}",
        )
    run(
        ["kubectl", "-n", NAMESPACE, "create", "serviceaccount", "upstream-20261029"],
        "create-ksa-upstream",
    )
    run(
        [
            "gcloud",
            "storage",
            "buckets",
            "create",
            f"gs://{BUCKET}",
            f"--project={PROJECT}",
            "--location=us-central1",
            "--uniform-bucket-level-access",
            "--quiet",
        ],
        "create-bucket",
    )
    state["created"].append("bucket")
    save()
    run(
        [
            "gcloud",
            "storage",
            "buckets",
            "add-iam-policy-binding",
            f"gs://{BUCKET}",
            f"--member=serviceAccount:{state['accounts']['allow']['email']}",
            "--role=roles/storage.objectViewer",
            "--quiet",
        ],
        "bind-bucket-allow",
    )
    probe = ROOT / "probe.json"
    probe.write_text(
        json.dumps({"qualification": "branchyard-anvil-wif", "date": "2026-10-29"})
        + "\n"
    )
    run(
        ["gcloud", "storage", "cp", str(probe), f"gs://{BUCKET}/probe.json", "--quiet"],
        "upload-probe",
    )


def cleanup():
    if state.get("cleanupComplete"):
        print("Cleanup was already verified; no resource operations were repeated.")
        return
    failures = []
    if "namespace" in state["created"]:
        result = run(
            [
                "kubectl",
                "delete",
                "namespace",
                NAMESPACE,
                "--wait=true",
                "--timeout=90s",
            ],
            "delete-namespace",
            False,
        )
        if result.returncode:
            failures.append("namespace deletion")
        result = run(
            [
                "kubectl",
                "get",
                "namespace",
                NAMESPACE,
                "--ignore-not-found",
                "-o",
                "name",
            ],
            "verify-namespace-absent",
            False,
        )
        if result.returncode or result.stdout.strip():
            failures.append("namespace absent")
    if "bucket" in state["created"]:
        result = run(
            ["gcloud", "storage", "rm", "--recursive", f"gs://{BUCKET}", "--quiet"],
            "delete-bucket",
            False,
        )
        if result.returncode:
            failures.append("bucket deletion")
        result = run(
            [
                "gcloud",
                "storage",
                "buckets",
                "describe",
                f"gs://{BUCKET}",
                "--format=value(name)",
            ],
            "verify-bucket-absent",
            False,
        )
        if result.returncode == 0 or "404" not in result.stderr:
            failures.append("bucket absent")
    for role in ["allow", "deny"]:
        if f"sa-{role}" not in state["created"]:
            continue
        email = state["accounts"][role]["email"]
        result = run(
            [
                "gcloud",
                "iam",
                "service-accounts",
                "delete",
                email,
                f"--project={PROJECT}",
                "--quiet",
            ],
            f"delete-sa-{role}",
            False,
        )
        if result.returncode:
            failures.append(f"{role} deletion")
        result = run(
            [
                "gcloud",
                "iam",
                "service-accounts",
                "describe",
                email,
                f"--project={PROJECT}",
                "--format=value(email)",
            ],
            f"verify-sa-{role}-absent",
            False,
        )
        # IAM reads can briefly lag a successful deletion; verify the project list below.
    deadline = time.monotonic() + 30
    while True:
        result = run(
            [
                "gcloud",
                "iam",
                "service-accounts",
                "list",
                f"--project={PROJECT}",
                "--filter=email:(by-wif-allow-20261029 OR by-wif-deny-20261029)",
                "--format=json(email,uniqueId)",
            ],
            "verify-accounts-absent",
            False,
        )
        remaining = (
            []
            if result.returncode
            else [
                account
                for account in json.loads(result.stdout)
                if account.get("uniqueId")
                in {value["uniqueId"] for value in state["accounts"].values()}
            ]
        )
        if result.returncode:
            failures.append("account absence check")
            break
        if not remaining:
            break
        if time.monotonic() >= deadline:
            failures.append("account absent")
            break
        time.sleep(1)
    state["cleanupFailures"] = failures
    state["cleanupComplete"] = not failures
    save()
    if failures:
        raise RuntimeError(", ".join(failures))


if sys.argv[1:] == ["create"]:
    create()
elif sys.argv[1:] == ["cleanup"]:
    cleanup()
else:
    raise SystemExit("usage: manage.py create|cleanup")
