#!/usr/bin/env node
import { formatEnoentError, runAnvilCli } from "./anvil-cli.js";
import { installEpipeExit } from "./io.js";

installEpipeExit();
runAnvilCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      process.stderr.write(`${formatEnoentError(nodeErr)}\n`);
    } else {
      process.stderr.write(`anvil: ${err?.message ?? err}\n`);
    }
    process.exitCode = 1;
  },
);
