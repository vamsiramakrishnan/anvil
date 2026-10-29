"""Stage compiled artifacts in the reviewed namespace; never print secret material."""

import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(os.environ["ANVIL_WIF_RECORD_DIR"])
NS = "by-atomic-wif-20261029"
PROJECT = os.environ["ANVIL_WIF_PROJECT"]
assert os.environ["KUBECONFIG"]
MCP_HOST = f"upstream-20261029.{NS}.svc.cluster.local"
BY_HOST = f"branchyard-20261029.{NS}.svc.cluster.local"
state = json.loads((ROOT / "resources.json").read_text())


def run(args, label, timeout=120):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    (ROOT / f"{label}.log").write_bytes(result.stdout + result.stderr)
    print(json.dumps({"step": label, "exit": result.returncode}), flush=True)
    if result.returncode:
        raise RuntimeError(f"{label} failed")


private = ROOT / "private"
private.mkdir(mode=0o700, exist_ok=True)
os.umask(0o077)
run(
    [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(private / "ca.key"),
        "-out",
        str(private / "ca.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=Branchyard qualification CA 20261029",
    ],
    "generate-ca",
)
run(
    [
        "openssl",
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(private / "server.key"),
        "-out",
        str(private / "server.csr"),
        "-subj",
        f"/CN={MCP_HOST}",
    ],
    "generate-leaf",
)
(private / "extensions").write_text(
    f"subjectAltName=DNS:{MCP_HOST},DNS:{BY_HOST},DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"
)
run(
    [
        "openssl",
        "x509",
        "-req",
        "-in",
        str(private / "server.csr"),
        "-CA",
        str(private / "ca.pem"),
        "-CAkey",
        str(private / "ca.key"),
        "-CAcreateserial",
        "-out",
        str(private / "server.pem"),
        "-days",
        "1",
        "-extfile",
        str(private / "extensions"),
    ],
    "sign-leaf",
)
run(
    [
        "kubectl",
        "-n",
        NS,
        "create",
        "secret",
        "generic",
        "tls-20261029",
        f"--from-file=server.pem={private}/server.pem",
        f"--from-file=server.key={private}/server.key",
    ],
    "create-tls-secret",
)
run(
    [
        "kubectl",
        "-n",
        NS,
        "create",
        "configmap",
        "trust-20261029",
        f"--from-file=ca.pem={private}/ca.pem",
    ],
    "create-trust",
)
os.umask(0o022)
items = []
for role in ["upstream", "allow", "deny"]:
    env = {
        "ROLE": role,
        "BUCKET": f"{PROJECT}-by-wif-20261029",
        "MCP_URL": f"https://{MCP_HOST}:8443/mcp",
        "BRANCHYARD_AUDIENCE": f"https://{BY_HOST}:8787",
        "NODE_EXTRA_CA_CERTS": "/trust/ca.pem",
        "ANVIL_INBOUND_AUTH_MODE": "branchyard",
        "ANVIL_INBOUND_ISSUER": "branchyard:local:wif-20261029",
        "ANVIL_INBOUND_AUDIENCE": "http://127.0.0.1:8080/mcp",
        "ANVIL_INBOUND_JWKS_URI": "file:///work/jwks.json",
        "ANVIL_VAULT_KEY_FILE": "/work/vault.key",
        "ANVIL_VAULT_DIR": "/work/vault",
        "ANVIL_AUDIT_FILE": "/work/audit.jsonl",
        "ANVIL_ALLOWED_HOSTS": MCP_HOST,
        "ANVIL_CONNECT_STORAGE_MCP_URL": f"https://{MCP_HOST}:8443/mcp",
        "ANVIL_CONNECT_STORAGE_MCP_AUTH": "workload",
        "ANVIL_ENV": "prod",
    }
    if role == "allow":
        env["ALLOWED_GOOGLE_SUBJECT"] = state["accounts"]["allow"]["uniqueId"]
    volumes = [
        {"name": "work", "emptyDir": {}},
        {"name": "trust", "configMap": {"name": "trust-20261029"}},
    ]
    mounts = [
        {"name": "work", "mountPath": "/work"},
        {"name": "trust", "mountPath": "/trust", "readOnly": True},
    ]
    if role != "deny":
        volumes.append({"name": "tls", "secret": {"secretName": "tls-20261029"}})
        mounts.append({"name": "tls", "mountPath": "/tls", "readOnly": True})
    items.append(
        {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": f"{role}-20261029",
                "namespace": NS,
                "labels": {"role": role, "purpose": "branchyard-wif-validation"},
            },
            "spec": {
                "serviceAccountName": f"{role}-20261029",
                "nodeSelector": {"kubernetes.io/arch": "amd64"},
                "restartPolicy": "Never",
                "containers": [
                    {
                        "name": "runtime",
                        "image": "node:22-trixie@sha256:ead00acb9f552752e0fe17a428d692094ab5f9e021e7bb97202fa7b0cd702a04",
                        "command": [
                            "node",
                            "-e",
                            "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},3600000)",
                        ],
                        "env": [{"name": k, "value": v} for k, v in env.items()],
                        "resources": {
                            "requests": {
                                "cpu": "500m" if role == "allow" else "250m",
                                "memory": "1Gi" if role == "allow" else "512Mi",
                                "ephemeral-storage": "2Gi",
                            },
                            "limits": {
                                "cpu": "1",
                                "memory": "2Gi",
                                "ephemeral-storage": "2Gi",
                            },
                        },
                        "volumeMounts": mounts,
                    }
                ],
                "volumes": volumes,
            },
        }
    )
for name, role, port in [
    ("upstream-20261029", "upstream", 8443),
    ("branchyard-20261029", "allow", 8787),
]:
    items.append(
        {
            "apiVersion": "v1",
            "kind": "Service",
            "metadata": {"name": name, "namespace": NS},
            "spec": {
                "type": "ClusterIP",
                "selector": {"role": role},
                "ports": [{"port": port, "targetPort": port}],
            },
        }
    )
manifest = ROOT / "pods.json"
manifest.write_text(
    json.dumps({"apiVersion": "v1", "kind": "List", "items": items}, indent=2) + "\n"
)
run(["kubectl", "create", "-f", str(manifest)], "create-pods-services")
run(
    [
        "kubectl",
        "-n",
        NS,
        "wait",
        "--for=condition=Ready",
        "pod",
        "--all",
        "--timeout=300s",
    ],
    "wait-pods",
    330,
)
shutil.copytree(
    ROOT / "scripts", ROOT / "anvil-runtime" / "qualification", dirs_exist_ok=True
)
payload = ROOT / "runtime.tar.gz"
run(
    ["tar", "-czf", str(payload), "-C", str(ROOT / "anvil-runtime"), "."],
    "package-runtime",
)
for role in ["upstream", "allow", "deny"]:
    with payload.open("rb") as source:
        result = subprocess.run(
            [
                "kubectl",
                "-n",
                NS,
                "exec",
                "-i",
                f"{role}-20261029",
                "--",
                "bash",
                "-c",
                "mkdir -p /work/runtime && tar -xzf - -C /work/runtime",
            ],
            stdin=source,
            capture_output=True,
            timeout=180,
        )
    print(
        json.dumps({"step": f"upload-runtime-{role}", "exit": result.returncode}),
        flush=True,
    )
    if result.returncode:
        raise RuntimeError("Runtime upload failed")
run(
    ["tar", "-czf", str(ROOT / "binaries.tar.gz"), "-C", str(ROOT / "bin"), "."],
    "package-binaries",
)
with (ROOT / "binaries.tar.gz").open("rb") as source:
    result = subprocess.run(
        [
            "kubectl",
            "-n",
            NS,
            "exec",
            "-i",
            "allow-20261029",
            "--",
            "tar",
            "-xzf",
            "-",
            "-C",
            "/work",
        ],
        stdin=source,
        capture_output=True,
        timeout=180,
    )
if result.returncode:
    raise RuntimeError("Binary upload failed")
run(
    [
        "kubectl",
        "-n",
        NS,
        "exec",
        "upstream-20261029",
        "--",
        "bash",
        "-c",
        "nohup node /work/runtime/qualification/upstream.mjs >/work/upstream.log 2>&1 </dev/null &",
    ],
    "start-upstream",
)
for role in ["allow", "deny"]:
    run(
        [
            "kubectl",
            "-n",
            NS,
            "exec",
            f"{role}-20261029",
            "--",
            "node",
            "/work/runtime/qualification/prepare.mjs",
        ],
        f"prepare-{role}",
    )
    run(
        [
            "kubectl",
            "-n",
            NS,
            "exec",
            f"{role}-20261029",
            "--",
            "bash",
            "-c",
            "nohup node /work/runtime/dist/bin-anvil.js serve mcp /work/workspace --fleet --http 8080 >/work/gateway.log 2>&1 </dev/null &",
        ],
        f"start-gateway-{role}",
    )
run(
    [
        "kubectl",
        "-n",
        NS,
        "exec",
        "allow-20261029",
        "--",
        "bash",
        "-c",
        "set -e; mkdir -p /work/repo; git -C /work/repo init -q -b main; git -C /work/repo -c user.name=Qualification -c user.email=qualification@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m initial; nohup /work/branchyard-server --config /work/server.json >/work/branchyard.log 2>&1 </dev/null &",
    ],
    "start-branchyard",
)
