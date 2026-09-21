import type { SdkPlan, SdkTokenGrant } from "./plan.js";

/**
 * The Go client's wiring for the two grants it can run on its own —
 * client-credentials minting (`oauth2_client_credentials`) and RFC 8693 token
 * exchange (`oauth2_on_behalf_of`): the compile-time constants, the
 * `clientConfig` fields, the `With…` options, and the `New()` resolution that
 * picks a provider. Each fragment is empty for a service whose contract
 * declares neither, so a bearer/api-key client is byte-identical to before.
 *
 * Precedence is the runtime's: an explicit provider wins, then an explicit
 * client credential, then a pre-minted static token, then the client
 * credential the environment names. The refresh grant's wiring stays in
 * `go.ts` beside the mTLS wiring it was written alongside.
 */

const g = (value: unknown): string => JSON.stringify(value);

/** The compile-time facts a grant against the token endpoint reads, by env-var NAME only. */
function constants(title: string, grant: SdkTokenGrant): string {
  return `
// ${title}
const TokenEndpoint = ${g(grant.tokenEndpoint)}
const ClientIDEnvVar = ${g(grant.clientIdEnvVar)}
const ClientSecretEnvVar = ${g(grant.clientSecretEnvVar)}

// TokenClientAuth is how the grant authenticates to the token endpoint — the
// same method the runtime uses for this contract.
const TokenClientAuth = ${g(grant.clientAuth)}

// TokenScopes are the contract's scopes; a caller may narrow them, never widen.
var TokenScopes = []string{${grant.scopes.map((scope) => g(scope)).join(", ")}}

const TokenAudience = ${g(grant.audience ?? "")}
const TokenResource = ${g(grant.resource ?? "")}
`;
}

export function goGrantConstants(plan: SdkPlan): string {
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
      ? `
// ActorTokenEnvVar is the acting party's token, read when WithActorToken is
// not given — the contract names an actor.
const ActorTokenEnvVar = ${g(exchange.actorTokenEnvVar)}
`
      : ""
  }const SubjectTokenType = ${g(exchange.subjectTokenType)}
const RequestedTokenType = ${g(exchange.requestedTokenType)}
`;
}

/** Extra `clientConfig` fields, appended after `tokenProvider`. */
export function goGrantConfigFields(plan: SdkPlan): string {
  const minting = plan.auth.clientCredentials;
  const exchange = plan.auth.tokenExchange;
  return `${
    minting || exchange
      ? `
	// clientID/clientSecret is the client's own credential to the contract's
	// token endpoint; scopes may narrow the contract's. Never logged or echoed.
	clientID     string
	clientSecret string
	scopes       []string`
      : ""
  }${
    exchange
      ? `
	// subjectToken is the inbound caller's token to act on behalf of; it is
	// exchanged, never sent upstream as-is, and never logged.
	subjectToken string
	actorToken   string`
      : ""
  }`;
}

/** The `With…` options a caller passes to `New`. */
export function goGrantOptions(plan: SdkPlan): string {
  const minting = plan.auth.clientCredentials;
  const exchange = plan.auth.tokenExchange;
  const grant = minting ?? exchange;
  if (!grant) return "";
  return `// WithClientCredentials sets the client's own credential to the contract's
// token endpoint${minting ? " — the SDK mints its bearer with it (RFC 6749 section 4.4)" : " — the SDK exchanges the subject token with it (RFC 8693)"}.
// Read from ${grant.clientIdEnvVar} / ${grant.clientSecretEnvVar} when not given.
// scopes narrows the contract's scopes; none keeps them. Never logged or echoed.
func WithClientCredentials(clientID, clientSecret string, scopes ...string) Option {
	return func(config *clientConfig) {
		config.clientID = clientID
		config.clientSecret = clientSecret
		if len(scopes) > 0 {
			config.scopes = scopes
		}
	}
}

${
  exchange
    ? `// WithSubjectToken sets the inbound caller's token to act on behalf of. It is
// exchanged at the declared token endpoint (never sent upstream as-is, never
// logged), and the exchanged token is cached until it expires.
func WithSubjectToken(subjectToken string) Option {
	return func(config *clientConfig) { config.subjectToken = subjectToken }
}

// WithActorToken sets the acting party's token, when the contract's
// delegation names an actor.${exchange.actorTokenEnvVar ? " Read from ActorTokenEnvVar when not given." : ""}
func WithActorToken(actorToken string) Option {
	return func(config *clientConfig) { config.actorToken = actorToken }
}

`
    : ""
}`;
}

/** The provider resolution inside `New`, after the options have been applied. */
export function goGrantWiring(plan: SdkPlan): string {
  const minting = plan.auth.clientCredentials;
  const exchange = plan.auth.tokenExchange;
  if (minting) {
    return `	// An explicit WithTokenProvider wins; then an explicit WithClientCredentials;
	// then a static token; then the client credential the environment names —
	// the same precedence the runtime gives a pre-minted token over minting one.
	explicit := config.clientID != ""
	if config.clientID == "" {
		config.clientID = os.Getenv(ClientIDEnvVar)
	}
	if config.clientSecret == "" {
		config.clientSecret = os.Getenv(ClientSecretEnvVar)
	}
	if config.tokenProvider == nil && (explicit || config.token == "") && config.clientID != "" && config.clientSecret != "" {
		scopes := TokenScopes
		if config.scopes != nil {
			scopes = config.scopes
		}
		config.tokenProvider = NewClientCredentialsTokenProvider(TokenEndpoint, config.clientID, config.clientSecret, ClientCredentialsOptions{
			ClientAuth: TokenClientAuth,
			Scopes:     scopes,
			Audience:   TokenAudience,
			Resource:   TokenResource,
			HTTPClient: config.httpClient,
		})
	}
`;
  }
  if (!exchange) return "";
  return `	// An explicit WithTokenProvider wins. Otherwise a subject token is
	// exchanged with the client credential given or named in the environment;
	// the static token is the fallback when no subject is given.
	if config.clientID == "" {
		config.clientID = os.Getenv(ClientIDEnvVar)
	}
	if config.clientSecret == "" {
		config.clientSecret = os.Getenv(ClientSecretEnvVar)
	}
${
  exchange.actorTokenEnvVar
    ? `	if config.actorToken == "" {
		config.actorToken = os.Getenv(ActorTokenEnvVar)
	}
	if config.subjectToken != "" && config.tokenProvider == nil && config.actorToken == "" {
		// The contract names an actor, so an exchange without one is incomplete:
		// refuse here rather than send a grant the runtime would refuse to send.
		return nil, &Error{
			Code:              ${g("auth_required")},
			Operation:         ${g(plan.service.id)},
			Message:           "This contract delegates through an actor; pass WithActorToken or set " + ActorTokenEnvVar + ".",
			RequiredArguments: []string{"WithActorToken"},
		}
	}
`
    : ""
}	if config.tokenProvider == nil && config.subjectToken != "" && config.clientID != "" {
		scopes := TokenScopes
		if config.scopes != nil {
			scopes = config.scopes
		}
		config.tokenProvider = NewTokenExchanger(TokenEndpoint, config.clientID, config.clientSecret, TokenExchangeOptions{
			ClientAuth:         TokenClientAuth,
			SubjectTokenType:   SubjectTokenType,
			RequestedTokenType: RequestedTokenType,
			Scopes:             scopes,
			Audience:           TokenAudience,
			Resource:           TokenResource,
			HTTPClient:         config.httpClient,
		}).TokenProvider(config.subjectToken, config.actorToken)
	}
`;
}
