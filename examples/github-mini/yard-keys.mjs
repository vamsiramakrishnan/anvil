#!/usr/bin/env node
// Stand-in for Branchyard's access broker in the connector fixture
// (docs/branchyard.md): an Ed25519 key, its JWKS, and per-turn tokens.
// Dependency-free; Branchyard mints its own tokens in production.
//
//   node examples/github-mini/yard-keys.mjs keygen <dir>
//     writes <dir>/signing.jwk.json (0600, private) and <dir>/jwks.json
//   node examples/github-mini/yard-keys.mjs mint <dir> --iss <iss> --aud <aud> \
//       --sub <sub> --grants '<json array>' [--ttl 600] [--tenant t] [--branch b] [--turn n]
//       [--purpose connect]
//     prints a compact EdDSA JWT; `--purpose connect` makes the person's
//     connect token (the only token the gateway's /connect/* routes take)
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Generate a key in `dir`; returns { kid, jwksPath }. */
export function keygen(dir) {
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = `yard-${randomUUID().slice(0, 8)}`;
  const privateJwk = { ...privateKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" };
  const publicJwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" };
  const signingPath = join(dir, "signing.jwk.json");
  writeFileSync(signingPath, JSON.stringify(privateJwk), { mode: 0o600 });
  chmodSync(signingPath, 0o600);
  const jwksPath = join(dir, "jwks.json");
  writeFileSync(jwksPath, JSON.stringify({ keys: [publicJwk] }, null, 2));
  return { kid, jwksPath };
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Mint a token with the key in `dir`. */
export function mint(dir, claims, { ttl = 600, now = Math.floor(Date.now() / 1000) } = {}) {
  const jwk = JSON.parse(readFileSync(join(dir, "signing.jwk.json"), "utf8"));
  const key = createPrivateKey({ key: jwk, format: "jwk" });
  const header = { alg: "EdDSA", typ: "JWT", kid: jwk.kid };
  const payload = { iat: now, exp: now + ttl, jti: randomUUID(), ...claims };
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const signature = sign(null, Buffer.from(signingInput), key).toString("base64url");
  return `${signingInput}.${signature}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, dir, ...rest] = process.argv.slice(2);
  const flag = (name) => {
    const index = rest.indexOf(`--${name}`);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  if (command === "keygen" && dir) {
    process.stdout.write(`${JSON.stringify(keygen(dir))}\n`);
  } else if (command === "mint" && dir) {
    const claims = {
      iss: flag("iss"),
      aud: flag("aud"),
      sub: flag("sub"),
      by_grants: JSON.parse(flag("grants") ?? "[]"),
      ...(flag("tenant") ? { by_tenant: flag("tenant") } : {}),
      ...(flag("branch") ? { by_branch: flag("branch") } : {}),
      ...(flag("turn") ? { by_turn: flag("turn") } : {}),
      ...(flag("purpose") ? { by_purpose: flag("purpose") } : {}),
    };
    process.stdout.write(`${mint(dir, claims, { ttl: Number(flag("ttl") ?? 600) })}\n`);
  } else {
    process.stderr.write("usage: yard-keys.mjs keygen <dir> | mint <dir> --iss --aud --sub --grants\n");
    process.exitCode = 2;
  }
}
