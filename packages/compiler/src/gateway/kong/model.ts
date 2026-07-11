/**
 * Kong declarative-config shapes (the `deck` dump format). Kept intentionally
 * loose — Kong configs carry vendor extensions we preserve as opaque rather than
 * reject. Only the fields the adapter normalizes are typed; everything else rides
 * along as `Record<string, unknown>` so nothing is silently dropped.
 */
export interface KongPlugin {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  tags?: string[];
}

export interface KongRoute {
  name?: string;
  paths?: string[];
  methods?: string[];
  hosts?: string[];
  protocols?: string[];
  plugins?: KongPlugin[];
  tags?: string[];
}

export interface KongService {
  name: string;
  url?: string;
  host?: string;
  path?: string;
  protocol?: string;
  routes?: KongRoute[];
  plugins?: KongPlugin[];
  tags?: string[];
}

export interface KongDeclarativeConfig {
  _format_version?: string;
  services?: KongService[];
  consumers?: Record<string, unknown>[];
  plugins?: KongPlugin[];
  [k: string]: unknown;
}
