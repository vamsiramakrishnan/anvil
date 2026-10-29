# Rerun the GKE qualification

These scripts create a temporary namespace, service accounts, and a bucket.
Use a project where you may create and remove those resources. Review the fixed
`20261029` resource names in `manage.py` and `deploy.py` before execution.
Existing cluster settings and project IAM policies are not changed.

The prerequisites are an existing GKE cluster with workload identity, namespace
and pod creation permission, service-account administration, and bucket
administration. Use an isolated kubeconfig that reaches that cluster. The
required Container, IAM, IAM Credentials, and Storage APIs must already be enabled.

1. Build Anvil with `pnpm build`. Build `by` and `branchyard-server` from a
   Branchyard revision that includes native Google ID-token admission.
2. Set the paths and project for this run. Use a fresh record directory so that
   the scripts preserve earlier evidence.

   ```sh
   export ANVIL_SOURCE=/path/to/anvil
   export BRANCHYARD_BIN_DIR=/path/to/branchyard/binaries
   export ANVIL_WIF_PROJECT=your-validation-project
   export ANVIL_WIF_RECORD_DIR=/tmp/anvil-wif-new-run
   export KUBECONFIG=/tmp/anvil-wif-kubeconfig
   gcloud container clusters get-credentials YOUR_CLUSTER --region=YOUR_REGION --project="$ANVIL_WIF_PROJECT" --internal-ip
   ```

3. Stage the compiled artifacts. This step copies the runtime dependencies and
   replaces two deployment symlinks that otherwise reach the checkout.

   ```sh
   python3 "$ANVIL_SOURCE/docs/qualification/gke-wif-20261029/stage.py"
   ```

4. Create the reviewed resources, then deploy the fixture. `manage.py` records
   each created resource before proceeding to the next one.

   ```sh
   python3 "$ANVIL_WIF_RECORD_DIR/scripts/manage.py" create
   python3 "$ANVIL_WIF_RECORD_DIR/scripts/deploy.py"
   ```

5. Wait for the gateway and Branchyard health endpoints to return 200. Run the
   checks sequentially because the fixture's request counters are shared.

   ```sh
   kubectl -n by-atomic-wif-20261029 exec allow-20261029 -- node /work/runtime/qualification/gateway-check.mjs
   kubectl -n by-atomic-wif-20261029 exec deny-20261029 -- node /work/runtime/qualification/gateway-check.mjs
   kubectl -n by-atomic-wif-20261029 exec allow-20261029 -- node /work/runtime/qualification/admission-check.mjs
   kubectl -n by-atomic-wif-20261029 exec deny-20261029 -- node /work/runtime/qualification/admission-check.mjs
   ```

6. Save the JSON results and binary hashes. Do not export bearer tokens, private
   keys, vault contents, or Kubernetes Secret objects.
7. Remove the recorded resources, including after a failed check. Confirm
   `cleanupComplete` in `resources.json`, then remove the local `private`
   directory and temporary kubeconfig.

   ```sh
   python3 "$ANVIL_WIF_RECORD_DIR/scripts/manage.py" cleanup
   ```

The launcher detaches the server process from `kubectl exec`. Cleanup polls the
account list because an immediate IAM lookup can be stale after deletion. These
two runner corrections followed the recorded run; they do not change the
runtime assertions.
