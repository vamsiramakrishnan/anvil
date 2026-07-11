#!/usr/bin/env node
import { runAnvilCli } from "./anvil-cli.js";
import { installEpipeExit } from "./io.js";

installEpipeExit();
runAnvilCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`anvil: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  },
);
