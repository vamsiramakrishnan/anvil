import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GATEWAY_DEPLOY_PREFIX, generateGatewayCloudRun } from "@anvil/generators";
import type { Command } from "commander";
import type { CommandContext } from "./context.js";

/**
 * `anvil deploy gateway --out <dir> ...`: write the fleet gateway's Cloud Run
 * Dockerfile and service definition (branchyard inbound JWKS, probes, Firestore
 * ledger, SIGTERM drain). Writes files only; it never contacts Google Cloud.
 */
export function registerDeployGateway(deploy: Command, ctx: CommandContext): void {
  deploy
    .command("gateway")
    .summary("Write the Cloud Run Dockerfile and service for the fleet gateway.")
    .description(
      "Writes deploy/gateway/Dockerfile and service.yaml for `anvil serve mcp <bundles> --fleet --http $PORT`: /readyz startup and /healthz liveness probes, the branchyard inbound-auth configuration (issuer, audience, JWKS), the Firestore idempotency ledger, and the SIGTERM drain window. Configuration only; it never applies anything.",
    )
    .requiredOption("--out <dir>", "directory to write deploy/gateway/ into")
    .requiredOption("--image <ref>", "container image reference built from the Dockerfile")
    .requiredOption("--project <id>", "GCP project id (the ledger's project)")
    .requiredOption("--public-url <url>", "the gateway's public https URL")
    .requiredOption("--branchyard-url <url>", "the Branchyard server's https URL (token issuer)")
    .option("--jwks-uri <url>", "JWKS URL (default: <branchyard-url>/.well-known/jwks.json)")
    .option("--service <name>", "Cloud Run service name", "anvil-gateway")
    .option("--ledger-database <id>", "Firestore database for the ledger", "(default)")
    .option("--ledger-namespace <name>", "ledger namespace", "gateway")
    .option("--env <env>", "ANVIL_ENV", "prod")
    .action(
      (opts: {
        out: string;
        image: string;
        project: string;
        publicUrl: string;
        branchyardUrl: string;
        jwksUri?: string;
        service: string;
        ledgerDatabase: string;
        ledgerNamespace: string;
        env: string;
      }) => {
        let files: Record<string, string>;
        try {
          files = generateGatewayCloudRun({
            serviceName: opts.service,
            image: opts.image,
            project: opts.project,
            publicUrl: opts.publicUrl,
            branchyardUrl: opts.branchyardUrl,
            ...(opts.jwksUri ? { jwksUri: opts.jwksUri } : {}),
            ledgerDatabase: opts.ledgerDatabase,
            ledgerNamespace: opts.ledgerNamespace,
            env: opts.env,
          });
        } catch (error) {
          ctx.io.err(`anvil deploy gateway: ${(error as Error).message}`);
          ctx.code = 1;
          return;
        }
        const root = resolve(opts.out);
        for (const [rel, contents] of Object.entries(files)) {
          const full = join(root, rel);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, contents, "utf8");
        }
        ctx.io.out(
          `Wrote ${Object.keys(files).length} file(s) to ${join(root, GATEWAY_DEPLOY_PREFIX)}.`,
        );
        ctx.io.out("No cloud call was made. Review service.yaml, then apply it yourself.");
      },
    );
}
