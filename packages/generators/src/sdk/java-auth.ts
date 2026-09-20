import type { SdkPlan, SdkTokenGrant } from "./plan.js";

/**
 * The Java client's wiring for the two grants it can run on its own —
 * client-credentials minting (`oauth2_client_credentials`) and RFC 8693 token
 * exchange (`oauth2_on_behalf_of`): the compile-time constants, the `Builder`
 * fields and setters, and the `build()` resolution that picks a supplier.
 * Each fragment is empty for a service whose contract declares neither, so a
 * bearer/api-key client is byte-identical to before.
 *
 * Precedence is the runtime's: an explicit supplier wins, then an explicit
 * client credential, then a pre-minted static token, then the client
 * credential the environment names. The refresh grant's wiring stays in
 * `java.ts` beside the mTLS wiring it was written alongside.
 */

const q = (value: unknown): string => JSON.stringify(value);

/** The compile-time facts a grant against the token endpoint reads, by env-var NAME only. */
function constants(title: string, grant: SdkTokenGrant): string {
  return `
  /** ${title} */
  public static final String TOKEN_ENDPOINT = ${q(grant.tokenEndpoint)};
  public static final String CLIENT_ID_ENV_VAR = ${q(grant.clientIdEnvVar)};
  public static final String CLIENT_SECRET_ENV_VAR = ${q(grant.clientSecretEnvVar)};
  /** How the grant authenticates to the token endpoint — the same method the runtime uses. */
  public static final String TOKEN_CLIENT_AUTH = ${q(grant.clientAuth)};
  /** The contract's scopes; a caller may narrow them, never widen. */
  public static final List<String> TOKEN_SCOPES =
      java.util.Collections.unmodifiableList(Arrays.asList(${grant.scopes.map((scope) => q(scope)).join(", ")}));
  public static final String TOKEN_AUDIENCE = ${grant.audience ? q(grant.audience) : "null"};
  public static final String TOKEN_RESOURCE = ${grant.resource ? q(grant.resource) : "null"};
`;
}

export function javaGrantConstants(plan: SdkPlan): string {
  const minting = plan.auth.clientCredentials;
  const exchange = plan.auth.tokenExchange;
  if (minting) {
    return constants(
      "Client-credentials minting against the contract's token endpoint (RFC 6749 section 4.4).",
      minting,
    );
  }
  if (!exchange) return "";
  return `${constants(
    "Token exchange (RFC 8693) against the contract's token endpoint, on behalf of a subject.",
    exchange,
  )}${
    exchange.actorTokenEnvVar
      ? `  /** The acting party's token, read when no actorToken is set — the contract names an actor. */
  public static final String ACTOR_TOKEN_ENV_VAR = ${q(exchange.actorTokenEnvVar)};
`
      : ""
  }  public static final String SUBJECT_TOKEN_TYPE = ${q(exchange.subjectTokenType)};
  public static final String REQUESTED_TOKEN_TYPE = ${q(exchange.requestedTokenType)};
`;
}

/** Extra `Builder` fields, appended after `tokenSupplier`. */
export function javaGrantBuilderFields(plan: SdkPlan): string {
  const minting = plan.auth.clientCredentials;
  const exchange = plan.auth.tokenExchange;
  return `${
    minting || exchange
      ? `
    private String clientId;
    private String clientSecret;
    private List<String> scopes;`
      : ""
  }${
    exchange
      ? `
    private String subjectToken;
    private String actorToken;`
      : ""
  }`;
}

/** The `Builder` setters a caller chains before `build()`. */
export function javaGrantBuilderMethods(plan: SdkPlan): string {
  const minting = plan.auth.clientCredentials;
  const exchange = plan.auth.tokenExchange;
  if (!minting && !exchange) return "";
  return `
    /**
     * The client's own credential to the contract's token endpoint${minting ? " — the SDK mints its bearer with it (RFC 6749 section 4.4)" : " — the SDK exchanges the subject token with it (RFC 8693)"}.
     * Read from CLIENT_ID_ENV_VAR / CLIENT_SECRET_ENV_VAR when not set. Never
     * logged, echoed, or included in an exception.
     */
    public Builder clientCredentials(String clientId, String clientSecret) {
      this.clientId = clientId;
      this.clientSecret = clientSecret;
      return this;
    }

    /** Narrows the contract's scopes for the grant; unset keeps them. */
    public Builder scopes(String... values) {
      this.scopes = java.util.Arrays.asList(values);
      return this;
    }
${
  exchange
    ? `
    /**
     * The inbound caller's token to act on behalf of. It is exchanged at the
     * declared token endpoint (never sent upstream as-is, never logged), and
     * the exchanged token is cached until it expires.
     */
    public Builder subjectToken(String value) {
      this.subjectToken = value;
      return this;
    }

    /** The acting party's token, when the contract's delegation names an actor.${exchange.actorTokenEnvVar ? " Read from ACTOR_TOKEN_ENV_VAR when not set." : ""} */
    public Builder actorToken(String value) {
      this.actorToken = value;
      return this;
    }
`
    : ""
}`;
}

/** The supplier resolution inside `build()`, before the client is constructed. */
export function javaGrantWiring(plan: SdkPlan): string {
  const minting = plan.auth.clientCredentials;
  const exchange = plan.auth.tokenExchange;
  if (minting) {
    return `      // An explicit tokenSupplier(...) wins; then an explicit clientCredentials(...);
      // then a static token; then the client credential the environment names —
      // the same precedence the runtime gives a pre-minted token over minting one.
      boolean explicit = clientId != null && !clientId.isEmpty();
      String grantClientId = explicit ? clientId : System.getenv(CLIENT_ID_ENV_VAR);
      String grantClientSecret =
          clientSecret != null ? clientSecret : System.getenv(CLIENT_SECRET_ENV_VAR);
      if (tokenSupplier == null
          && (explicit || token == null || token.isEmpty())
          && grantClientId != null
          && !grantClientId.isEmpty()
          && grantClientSecret != null
          && !grantClientSecret.isEmpty()) {
        tokenSupplier =
            Oauth.clientCredentialsTokenProvider(
                TOKEN_ENDPOINT,
                grantClientId,
                grantClientSecret,
                TOKEN_CLIENT_AUTH,
                scopes != null ? scopes : TOKEN_SCOPES,
                TOKEN_AUDIENCE,
                TOKEN_RESOURCE);
      }
`;
  }
  if (!exchange) return "";
  return `      // An explicit tokenSupplier(...) wins. Otherwise a subjectToken is
      // exchanged with the client credential set or named in the environment;
      // the static token is the fallback when no subject is given.
      String grantClientId = clientId != null ? clientId : System.getenv(CLIENT_ID_ENV_VAR);
      String grantClientSecret =
          clientSecret != null ? clientSecret : System.getenv(CLIENT_SECRET_ENV_VAR);
      String grantActorToken = actorToken${exchange.actorTokenEnvVar ? " != null ? actorToken : System.getenv(ACTOR_TOKEN_ENV_VAR)" : ""};
${
  exchange.actorTokenEnvVar
    ? `      if (subjectToken != null
          && !subjectToken.isEmpty()
          && tokenSupplier == null
          && (grantActorToken == null || grantActorToken.isEmpty())) {
        // The contract names an actor, so an exchange without one is incomplete:
        // refuse here rather than send a grant the runtime would refuse to send.
        throw AnvilException.builder(
                "auth_required",
                ${q(plan.service.id)},
                "This contract delegates through an actor; set actorToken(...) or "
                    + ACTOR_TOKEN_ENV_VAR
                    + ".")
            .requiredArguments("actorToken")
            .build();
      }
`
    : ""
}      if (tokenSupplier == null
          && subjectToken != null
          && !subjectToken.isEmpty()
          && grantClientId != null
          && !grantClientId.isEmpty()) {
        tokenSupplier =
            Oauth.tokenExchanger(
                    TOKEN_ENDPOINT,
                    grantClientId,
                    grantClientSecret,
                    TOKEN_CLIENT_AUTH,
                    new Oauth.TokenExchangeOptions()
                        .subjectTokenType(SUBJECT_TOKEN_TYPE)
                        .requestedTokenType(REQUESTED_TOKEN_TYPE)
                        .scopes(scopes != null ? scopes : TOKEN_SCOPES)
                        .audience(TOKEN_AUDIENCE)
                        .resource(TOKEN_RESOURCE))
                .tokenSupplier(subjectToken, grantActorToken);
      }
`;
}
