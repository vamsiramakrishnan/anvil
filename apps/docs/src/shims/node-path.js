/**
 * Browser shim for node:path (posix flavor) — the subset @anvil/compiler's
 * bundle links against. The compile-from-string path only calls
 * posix.normalize/dirname/join plus basename/extname; relative/resolve are
 * exported so the bundle links, with honest implementations anyway.
 */

export const sep = "/";

export function normalize(p) {
  if (p.length === 0) return ".";
  const abs = p.startsWith("/");
  const trailing = p.endsWith("/") && p.length > 1;
  const out = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(part);
  }
  let res = out.join("/");
  if (abs) res = `/${res}`;
  else if (res.length === 0) res = ".";
  if (trailing && !res.endsWith("/")) res += "/";
  return res;
}

export function join(...parts) {
  const joined = parts.filter((p) => p.length > 0).join("/");
  return joined.length === 0 ? "." : normalize(joined);
}

export function dirname(p) {
  if (p.length === 0) return ".";
  const trimmed = p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

export function basename(p, ext) {
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf("/");
  let base = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length);
  return base;
}

export function extname(p) {
  const base = basename(p);
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx);
}

export function resolve(...parts) {
  let path = "";
  for (const part of parts) {
    if (part.startsWith("/")) path = part;
    else path = path.length === 0 ? part : `${path}/${part}`;
  }
  const normalized = normalize(path);
  return normalized.startsWith("/") ? normalized : `/${normalized === "." ? "" : normalized}`;
}

export function relative(from, to) {
  const f = resolve(from).split("/").filter(Boolean);
  const t = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  return [...f.slice(i).map(() => ".."), ...t.slice(i)].join("/");
}

export function isAbsolute(p) {
  return p.startsWith("/");
}

const posixApi = {
  sep,
  normalize,
  join,
  dirname,
  basename,
  extname,
  resolve,
  relative,
  isAbsolute,
};
export const posix = posixApi;
export const win32 = posixApi;
export default { ...posixApi, posix: posixApi, win32: posixApi };
