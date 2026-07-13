/**
 * Browser stub for node:fs. The compiler bundle links against fs (snapshot
 * store / source import — Layer 0 persistence), but the compile-from-string
 * path never calls it. Every function throws so an accidental reach into the
 * filesystem is loud, not silent.
 */
function unavailable(name) {
  return () => {
    throw new Error(`node:fs.${name} is not available in the browser playground`);
  };
}

export const existsSync = () => false;
export const readFileSync = unavailable("readFileSync");
export const realpathSync = unavailable("realpathSync");
export const statSync = unavailable("statSync");
export const writeFileSync = unavailable("writeFileSync");
export const mkdirSync = unavailable("mkdirSync");
export const readdirSync = unavailable("readdirSync");
export const renameSync = unavailable("renameSync");
export const rmSync = unavailable("rmSync");
export const openSync = unavailable("openSync");
export const closeSync = unavailable("closeSync");
export const fsyncSync = unavailable("fsyncSync");
export const chmodSync = unavailable("chmodSync");
export const lstatSync = unavailable("lstatSync");
export const symlinkSync = unavailable("symlinkSync");

export default {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  fsyncSync,
  chmodSync,
  lstatSync,
  symlinkSync,
};
