const base = process.env.BRANCHYARD_AUDIENCE;
const getIdentity = async (audience) => {
  const url = new URL(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
  );
  url.searchParams.set("audience", audience);
  url.searchParams.set("format", "full");
  const response = await fetch(url, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Metadata identity status ${response.status}`);
  return response.text();
};
const assertions = [];
const check = (name, value) => {
  assertions.push({ name, passed: Boolean(value) });
  if (!value) throw new Error(`Qualification failed: ${name}`);
};
const request = async (token, path) => {
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  await response.body?.cancel();
  return response.status;
};
const identity = await getIdentity(base);
if (process.env.ROLE === "allow") {
  check(
    "real Google exact issuer subject audience admission",
    (await request(identity, "/v1/repos")) === 200,
  );
  check(
    "native admission preserves configured read-only scope",
    (await request(identity, "/metrics")) === 403,
  );
  const wrongAudience = await getIdentity(`${base}/wrong-audience`);
  check("real Google wrong audience rejected", (await request(wrongAudience, "/v1/repos")) === 401);
} else {
  check("real Google unmapped subject rejected", (await request(identity, "/v1/repos")) === 401);
}
console.log(
  JSON.stringify({ role: process.env.ROLE, assertions, realGoogleMetadataIdentity: true }),
);
