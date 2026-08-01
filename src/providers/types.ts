/** What a provider can be asked to produce. Drives routing and UI filtering. */
export type Capability =
  | "text"
  | "vision"
  | "embed"
  | "image"
  | "video"
  | "audio"
  | "voice"
  | "mesh3d";

/**
 * `local` providers run on the operator's own hardware and need no key — they are
 * probed by endpoint instead. `cloud` providers are BYOK: the operator supplies a
 * key obtained from `keyUrl`.
 */
export type ProviderKind = "local" | "cloud";

/** Wire protocol, so one adapter can serve many providers. */
export type ProtocolId = "openai-compatible" | "ollama" | "anthropic" | "custom";

export interface ProviderSpec {
  id: string;
  name: string;
  kind: ProviderKind;
  protocol: ProtocolId;
  capabilities: Capability[];
  /** Default endpoint. For local providers this is the probe target. */
  baseUrl: string;
  /**
   * Where the operator obtains a key (cloud) or the software (local).
   * Surfaced as a link in the BYOK tab so setup never requires a search.
   */
  keyUrl: string;
  /** Environment variable consulted before the keystore, for CI and headless runs. */
  envVar?: string;
  /** HTTP header used to carry the key. */
  authHeader?: string;
  /** Formats the header value from the raw key. */
  authScheme?: (key: string) => string;
  /** Path appended to baseUrl for a cheap liveness/auth check. */
  probePath?: string;
  notes?: string;
}

export interface ProviderStatus {
  id: string;
  name: string;
  kind: ProviderKind;
  capabilities: Capability[];
  baseUrl: string;
  keyUrl: string;
  /** Cloud: a key is present. Local: always true, keys are not used. */
  configured: boolean;
  /** Where the key came from, so the operator can tell env from keystore. */
  keySource: "env" | "keystore" | "none";
  /** Populated by probeProvider(); undefined means not yet probed. */
  reachable?: boolean;
  /** Models the endpoint reported, when the probe returned a list. */
  models?: string[];
  error?: string;
}
