import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

/** Drain output to disk; keep a bounded diagnostic tail and kill timed-out children. */
export function run(command, args, { cwd, log, timeoutMs = 120_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    const output = log ? createWriteStream(log) : undefined;
    let tail = "";
    let timedOut = false;
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const capture = (chunk) => {
      output?.write(chunk);
      tail = (tail + chunk.toString()).slice(-16_384);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    let error;
    child.on("error", (err) => { error = err.message; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      output?.end();
      resolve({ code, signal, timedOut, ms: Math.round(performance.now() - start), tail, error });
    });
  });
}
