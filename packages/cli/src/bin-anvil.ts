#!/usr/bin/env node
import { runAnvilCli } from "./anvil-cli.js";

runAnvilCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`anvil: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  },
);
