/**
 * Browser stub for swagger2openapi. The real package drags in node-fetch,
 * yargs, and fs through oas-resolver — none of it bundles for the browser.
 * It is only reached when the pasted spec is Swagger 2.0, so the playground
 * degrades to a clear message instead: paste OpenAPI 3.x.
 */
export async function convertObj() {
  throw new Error(
    "Swagger 2.0 conversion is not available in the browser playground — paste an OpenAPI 3.x document instead.",
  );
}

export default { convertObj };
