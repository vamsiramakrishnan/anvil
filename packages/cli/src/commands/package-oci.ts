import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { stableJson } from "../search-index.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil package oci <package-dir> --out <dir> [--push <ref>]` — a harness
 * package as an OCI image layout (Branchyard contract v2, item 4).
 *
 * The layout is the standard one: `oci-layout`, `index.json`, and `blobs/sha256/<hex>`.
 * One image manifest describes the package. Its config blob is a small JSON
 * record, and each package file is one layer, named by the file's SHA-256, with
 * its path in `org.opencontainers.image.title`. The index and the manifest both
 * carry `dev.anvil.bundle-hash`, `dev.anvil.connector` and `dev.anvil.version`.
 * Nothing in it reads a clock, so one package gives one layout, byte for byte.
 */

const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
const INDEX_TYPE = "application/vnd.oci.image.index.v1+json";
const CONFIG_TYPE = "application/vnd.dev.anvil.package.config.v1+json";
const FILE_TYPE = "application/vnd.dev.anvil.package.file.v1";
const TITLE = "org.opencontainers.image.title";

export function registerPackageOci(pkg: Command, ctx: CommandContext): void {
  annotate(
    pkg
      .command("oci")
      .summary("Write a harness package as an OCI image layout, and optionally push it.")
      .description(
        "Writes <out>/oci-layout, index.json and blobs/sha256/<digest>: one blob per package file, a config blob, an image manifest, and an index annotated with dev.anvil.bundle-hash, dev.anvil.connector and dev.anvil.version. Running it again on the same package writes the same bytes. With --push <ref> it uploads the blobs the registry lacks and then the manifest through the registry's HTTP API; a manifest already there with the same digest is left alone. The token, when the registry needs one, is read from the file named by ANVIL_OCI_TOKEN_FILE.",
      )
      .argument("<package-dir>", "a directory written by `anvil package harness`")
      .requiredOption("--out <dir>", "the OCI layout directory to write")
      .option(
        "--push <ref>",
        "push to <host>[:port]/<repository>[:<tag>] after writing (tag defaults to latest)",
      )
      .action(async (dir: string, opts: { out: string; push?: string }) => {
        ctx.code = await runPackageOci(dir, opts, ctx.io);
      }),
    { mutates: true },
  );
}

interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  annotations?: Record<string, string>;
}

interface Layout {
  blobs: Map<string, Buffer>;
  manifest: Descriptor;
  index: Buffer;
  tag?: string;
}

const digestOf = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function descriptor(
  mediaType: string,
  bytes: Buffer,
  annotations?: Record<string, string>,
): Descriptor {
  return {
    mediaType,
    digest: digestOf(bytes),
    size: bytes.length,
    ...(annotations ? { annotations } : {}),
  };
}

/** Every regular file under `root`, by relative path in byte order. Symbolic links are refused. */
function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isSymbolicLink())
      throw new Error(`${path} is a symbolic link; a package holds files only`);
    if (entry.isDirectory()) out.push(...listFiles(root, path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The in-memory layout of a package directory. Throws a plain message when it is not a harness package. */
export function buildLayout(packageDir: string): Layout {
  const root = resolve(packageDir);
  let harness: { connector?: unknown; bundle_hash?: unknown; service?: { version?: unknown } };
  try {
    harness = JSON.parse(readFileSync(join(root, "harness.json"), "utf8"));
  } catch (error) {
    throw new Error(`${root} is not a harness package (harness.json): ${(error as Error).message}`);
  }
  const { connector, bundle_hash: bundleHash } = harness;
  const version = harness.service?.version;
  if (
    typeof connector !== "string" ||
    typeof bundleHash !== "string" ||
    typeof version !== "string"
  ) {
    throw new Error(
      `${root}/harness.json lacks connector, bundle_hash or service.version; repackage with \`anvil package harness\``,
    );
  }
  const annotations = {
    "dev.anvil.bundle-hash": bundleHash,
    "dev.anvil.connector": connector,
    "dev.anvil.version": version,
  };
  const blobs = new Map<string, Buffer>();
  const layers: Descriptor[] = [];
  for (const path of listFiles(root)) {
    const full = join(root, path);
    const bytes = readFileSync(full);
    const mode = (lstatSync(full).mode & 0o111) !== 0 ? "755" : "644";
    const layer = descriptor(FILE_TYPE, bytes, { [TITLE]: path, "dev.anvil.mode": mode });
    blobs.set(layer.digest, bytes);
    layers.push(layer);
  }
  const config = Buffer.from(
    stableJson({ schema: "anvil.package/v1", connector, bundle_hash: bundleHash, version }),
  );
  blobs.set(digestOf(config), config);
  const manifestBytes = Buffer.from(
    stableJson({
      schemaVersion: 2,
      mediaType: MANIFEST_TYPE,
      config: descriptor(CONFIG_TYPE, config),
      layers,
      annotations,
    }),
  );
  const manifest = descriptor(MANIFEST_TYPE, manifestBytes, annotations);
  blobs.set(manifest.digest, manifestBytes);
  const index = Buffer.from(
    stableJson({
      schemaVersion: 2,
      mediaType: INDEX_TYPE,
      manifests: [manifest],
      annotations,
    }),
  );
  return { blobs, manifest, index };
}

const blobPath = (out: string, digest: string) =>
  join(out, "blobs", "sha256", digest.slice("sha256:".length));

/** Write the layout. A blob already present is kept, so a rerun changes nothing. */
export function writeLayout(layout: Layout, out: string): number {
  mkdirSync(join(out, "blobs", "sha256"), { recursive: true });
  let written = 0;
  for (const [digest, bytes] of layout.blobs) {
    const path = blobPath(out, digest);
    if (existsSync(path) && digestOf(readFileSync(path)) === digest) continue;
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, bytes);
    renameSync(temp, path);
    written++;
  }
  const marker = Buffer.from(`${JSON.stringify({ imageLayoutVersion: "1.0.0" })}\n`);
  for (const [name, bytes] of [
    ["oci-layout", marker],
    ["index.json", layout.index],
  ] as const) {
    const path = join(out, name);
    if (existsSync(path) && readFileSync(path).equals(bytes)) continue;
    writeFileSync(path, bytes);
  }
  return written;
}

/**
 * Check a layout directory against the OCI image layout rules this writer
 * follows: the marker, the index, and for every manifest its config and layers
 * present with the size and SHA-256 they claim. Returns one message per problem.
 */
export function checkLayout(out: string): string[] {
  const problems: string[] = [];
  const json = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      problems.push(`${path}: ${(error as Error).message}`);
      return undefined;
    }
  };
  const marker = json(join(out, "oci-layout")) as { imageLayoutVersion?: unknown } | undefined;
  if (marker && marker.imageLayoutVersion !== "1.0.0")
    problems.push("oci-layout: imageLayoutVersion is not 1.0.0");
  const blob = (d: Descriptor, what: string): Buffer | undefined => {
    if (!/^sha256:[0-9a-f]{64}$/.test(d.digest ?? "")) {
      problems.push(`${what}: digest ${String(d.digest)} is not sha256:<64 hex>`);
      return undefined;
    }
    const path = blobPath(out, d.digest);
    if (!existsSync(path)) {
      problems.push(`${what}: blob ${d.digest} is missing`);
      return undefined;
    }
    const bytes = readFileSync(path);
    if (bytes.length !== d.size)
      problems.push(`${what}: blob ${d.digest} has ${bytes.length} bytes, not ${d.size}`);
    if (digestOf(bytes) !== d.digest)
      problems.push(`${what}: blob ${d.digest} does not hash to its name`);
    return bytes;
  };
  const index = json(join(out, "index.json")) as
    | { schemaVersion?: unknown; manifests?: Descriptor[] }
    | undefined;
  if (!index) return problems;
  if (
    index.schemaVersion !== 2 ||
    !Array.isArray(index.manifests) ||
    index.manifests.length === 0
  ) {
    problems.push("index.json: schemaVersion must be 2 and manifests a non-empty list");
    return problems;
  }
  for (const entry of index.manifests) {
    for (const key of ["dev.anvil.bundle-hash", "dev.anvil.connector", "dev.anvil.version"]) {
      if (!entry.annotations?.[key])
        problems.push(`index.json: manifest ${entry.digest} lacks ${key}`);
    }
    const bytes = blob(entry, `manifest ${entry.digest}`);
    if (!bytes) continue;
    const manifest = JSON.parse(bytes.toString("utf8")) as {
      config: Descriptor;
      layers: Descriptor[];
    };
    blob(manifest.config, "config");
    for (const layer of manifest.layers)
      blob(layer, `layer ${layer.annotations?.[TITLE] ?? layer.digest}`);
  }
  return problems;
}

interface Reference {
  base: string;
  repository: string;
  tag: string;
}

function parseReference(ref: string): Reference {
  const match =
    /^([A-Za-z0-9.-]+(?::\d+)?|\[[0-9a-f:]+\](?::\d+)?)\/([a-z0-9][a-z0-9._/-]*?)(?::([A-Za-z0-9_][A-Za-z0-9._-]{0,127}))?$/.exec(
      ref,
    );
  if (!match || ref.includes("@")) {
    throw new Error(`'${ref}' is not <host>[:port]/<repository>[:<tag>]`);
  }
  const host = match[1] as string;
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return {
    base: `${loopback ? "http" : "https"}://${host}`,
    repository: match[2] as string,
    tag: match[3] ?? "latest",
  };
}

/** Push the manifest and the blobs the registry lacks. Returns how many blobs were uploaded. */
export async function pushLayout(
  layout: Layout,
  ref: string,
  token: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{ uploaded: number; manifestPushed: boolean }> {
  const target = parseReference(ref);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const call = (url: string, init: RequestInit = {}) =>
    fetcher(url, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(30_000),
    });
  const root = `${target.base}/v2/${target.repository}`;
  const fail = (what: string, response: Response) =>
    new Error(`${what}: the registry answered ${response.status}`);
  const manifestUrl = `${root}/manifests/${target.tag}`;
  const present = await call(manifestUrl, { method: "HEAD", headers: { accept: MANIFEST_TYPE } });
  if (present.ok && present.headers.get("docker-content-digest") === layout.manifest.digest) {
    return { uploaded: 0, manifestPushed: false };
  }
  const manifestBytes = layout.blobs.get(layout.manifest.digest) as Buffer;
  const wanted = JSON.parse(manifestBytes.toString("utf8")) as {
    config: Descriptor;
    layers: Descriptor[];
  };
  let uploaded = 0;
  for (const item of [wanted.config, ...wanted.layers]) {
    const head = await call(`${root}/blobs/${item.digest}`, { method: "HEAD" });
    if (head.ok) continue;
    const start = await call(`${root}/blobs/uploads/`, { method: "POST" });
    if (start.status !== 202) throw fail(`starting the upload of ${item.digest}`, start);
    const location = start.headers.get("location");
    if (!location) throw new Error(`starting the upload of ${item.digest}: no Location header`);
    const url = new URL(location, `${target.base}/`);
    url.searchParams.set("digest", item.digest);
    const put = await call(url.toString(), {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: layout.blobs.get(item.digest) as Buffer,
    });
    if (put.status !== 201) throw fail(`uploading ${item.digest}`, put);
    uploaded++;
  }
  const put = await call(manifestUrl, {
    method: "PUT",
    headers: { "content-type": MANIFEST_TYPE },
    body: manifestBytes,
  });
  if (put.status !== 201) throw fail("pushing the manifest", put);
  return { uploaded, manifestPushed: true };
}

async function runPackageOci(
  dir: string,
  opts: { out: string; push?: string },
  io: CliIO,
): Promise<number> {
  const out = resolve(opts.out);
  let layout: Layout;
  try {
    layout = buildLayout(dir);
    if (opts.push !== undefined) parseReference(opts.push);
  } catch (error) {
    io.err(`anvil: ${(error as Error).message}`);
    return 1;
  }
  if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(join(out, "oci-layout"))) {
    io.err(
      `anvil: ${out} exists and is not an OCI layout; refusing to write into it. Choose an empty or new --out.`,
    );
    return 1;
  }
  const written = writeLayout(layout, out);
  const problems = checkLayout(out);
  if (problems.length > 0) {
    io.err(`anvil: the layout at ${out} does not check out:\n  ${problems.join("\n  ")}`);
    return 1;
  }
  io.out(
    `Wrote OCI layout ${out} (manifest ${layout.manifest.digest}, ${layout.blobs.size} blob(s), ${written} new).`,
  );
  if (opts.push === undefined) return 0;
  let token: string | undefined;
  const tokenFile = process.env.ANVIL_OCI_TOKEN_FILE;
  if (tokenFile) {
    try {
      token = readFileSync(tokenFile, "utf8").trim() || undefined;
    } catch (error) {
      io.err(`anvil: cannot read ANVIL_OCI_TOKEN_FILE: ${(error as Error).message}`);
      return 1;
    }
  }
  try {
    const result = await pushLayout(layout, opts.push, token);
    io.out(
      result.manifestPushed
        ? `Pushed ${opts.push} (${result.uploaded} blob(s) uploaded).`
        : `${opts.push} already holds ${layout.manifest.digest}; nothing pushed.`,
    );
    return 0;
  } catch (error) {
    io.err(`anvil: push to ${opts.push} failed: ${(error as Error).message}`);
    return 1;
  }
}
