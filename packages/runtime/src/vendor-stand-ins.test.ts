import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Two retired packages that google-auth-library pulls in are replaced by stand-ins in
// vendor/ (pnpm overrides). Resolve each one the way its real consumer does, so a lost
// override fails here rather than quietly reinstalling the retired package.
const from = (req: NodeJS.Require, dependency: string) =>
  createRequire(realpathSync(req.resolve(`${dependency}/package.json`)));
const runtime = createRequire(import.meta.url);
const googleAuth = from(runtime, "google-auth-library");
const jwaRequire = from(from(googleAuth, "jws"), "jwa");
const nodeFetch = from(from(googleAuth, "gaxios"), "node-fetch");

describe("vendor stand-ins", () => {
  it("jwa compares HMAC signatures with the built-in constant-time stand-in", () => {
    const path = realpathSync(jwaRequire.resolve("buffer-equal-constant-time"));
    expect(path).toContain("/vendor/buffer-equal-constant-time/");
    const bufferEqual = jwaRequire("buffer-equal-constant-time") as (
      a: unknown,
      b: unknown,
    ) => boolean;
    expect(bufferEqual(Buffer.from("abc"), Buffer.from("abc"))).toBe(true);
    expect(bufferEqual(Buffer.from("abc"), Buffer.from("abd"))).toBe(false);
    expect(bufferEqual(Buffer.from("abc"), Buffer.from("abcd"))).toBe(false);
    expect(bufferEqual("abc", "abc")).toBe(false);

    const hs256 = (
      jwaRequire("jwa") as (alg: string) => {
        sign(input: string, key: string): string;
        verify(input: string, signature: string, key: string): boolean;
      }
    )("HS256");
    const signature = hs256.sign("payload", "k1");
    expect(hs256.verify("payload", signature, "k1")).toBe(true);
    expect(hs256.verify("payload", signature, "k2")).toBe(false);
  });

  it("fetch-blob gets Node's own DOMException from the stand-in", () => {
    const blob = from(nodeFetch, "fetch-blob");
    const path = realpathSync(blob.resolve("node-domexception"));
    expect(path).toContain("/vendor/node-domexception/");
    expect(blob("node-domexception")).toBe(globalThis.DOMException);
  });
});
