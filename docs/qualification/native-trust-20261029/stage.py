"""Package the compiled CLI and supplied Branchyard binaries without checkout links."""

import os
from pathlib import Path
import shutil
import subprocess

root = Path(os.environ["ANVIL_WIF_RECORD_DIR"]).resolve()
source = Path(os.environ["ANVIL_SOURCE"]).resolve()
binaries = Path(os.environ["BRANCHYARD_BIN_DIR"]).resolve()
root.mkdir(parents=True, exist_ok=True)
payload = root / "anvil-runtime"
subprocess.run(
    ["pnpm", "--filter", "@anvil/cli", "deploy", "--prod", "--legacy", str(payload)],
    cwd=source,
    check=True,
)
for path in list(payload.rglob("*")):
    if not path.is_symlink() or path.resolve().is_relative_to(payload):
        continue
    target = path.resolve()
    if target == source / "packages/cli":
        path.unlink()
        path.symlink_to(os.path.relpath(payload, path.parent), target_is_directory=True)
    elif target == source / "vendor/zod-to-json-schema":
        path.unlink()
        shutil.copytree(target, path)
    else:
        raise RuntimeError(f"Unreviewed external package link: {path}")
for path in payload.rglob("*"):
    if path.is_symlink() and not path.resolve().is_relative_to(payload):
        raise RuntimeError("Runtime package escapes its deployment directory")
shutil.copytree(Path(__file__).parent, root / "scripts", dirs_exist_ok=True)
(root / "bin").mkdir(exist_ok=True)
for name in ["by", "branchyard-server", "fake-acp-agent"]:
    shutil.copy2(binaries / name, root / "bin" / name)
subprocess.run(
    ["node", str(payload / "dist/bin-anvil.js"), "--help"],
    check=True,
    stdout=subprocess.DEVNULL,
)
print("Compiled runtime is self-contained; no cloud resources were created.")
