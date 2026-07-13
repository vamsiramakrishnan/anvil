/**
 * Browser stub for node:fs/promises. Only `glob` is imported by the compiler
 * bundle (source import discovery — never on the compile-from-string path).
 */
export async function* glob() {
  throw new Error("node:fs/promises.glob is not available in the browser playground");
}

export default { glob };
