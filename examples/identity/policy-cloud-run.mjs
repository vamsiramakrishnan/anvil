// Loaded with ANVIL_EXTENSIONS=/absolute/path/policy-cloud-run.mjs.
// ADC uses the attached workload identity; the destination requires roles/run.invoker.
export default api => ({
  name: "enterprise-policy",
  identityAuthorizers: {
    enterprise: api.createGoogleIdentityAuthorizer({
      endpoint: "https://POLICY_SERVICE-REGION.run.app/decide",
    }),
  },
});
