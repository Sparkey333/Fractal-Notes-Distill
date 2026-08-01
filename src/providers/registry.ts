import { paths } from "../core/paths.ts";
import { readJson, updateJson } from "../core/store.ts";
import { PROVIDER_CATALOG, requireProvider } from "./catalog.ts";
import { hasKey, keySource, resolveKey } from "./keystore.ts";
import type { Capability, ProviderSpec, ProviderStatus } from "./types.ts";

/**
 * Runtime view over the catalog: applies per-install endpoint overrides, reports
 * configuration state for the BYOK tab, and probes endpoints for liveness.
 */

interface ProviderConfig {
  /** providerId -> endpoint override. Self-hosted ports move; this absorbs that. */
  baseUrls?: Record<string, string>;
  /** Preferred provider per capability, consulted by routing. */
  defaults?: Partial<Record<Capability, string>>;
}

function config(): ProviderConfig {
  return readJson<ProviderConfig>(paths.config, {});
}

export function baseUrlFor(providerId: string): string {
  const spec = requireProvider(providerId);
  return config().baseUrls?.[providerId] ?? spec.baseUrl;
}

export function setBaseUrl(providerId: string, url: string): void {
  requireProvider(providerId);
  const parsed = new URL(url); // throws on malformed input, which is the point
  updateJson<ProviderConfig>(paths.config, {}, (cfg) => ({
    ...cfg,
    baseUrls: {
      ...cfg.baseUrls,
      [providerId]: parsed.toString().replace(/\/$/, ""),
    },
  }));
}

export function setDefault(capability: Capability, providerId: string): void {
  const spec = requireProvider(providerId);
  if (!spec.capabilities.includes(capability)) {
    throw new Error(
      `${spec.name} does not provide "${capability}" ` +
        `(it provides: ${spec.capabilities.join(", ")}).`,
    );
  }
  updateJson<ProviderConfig>(paths.config, {}, (cfg) => ({
    ...cfg,
    defaults: { ...cfg.defaults, [capability]: providerId },
  }));
}

export function getDefault(capability: Capability): string | undefined {
  return config().defaults?.[capability];
}

/** Auth headers for a provider, or undefined when it needs none (local). */
export function authHeaders(providerId: string): Record<string, string> {
  const spec = requireProvider(providerId);
  if (spec.kind === "local" || !spec.authHeader) return {};
  const resolved = resolveKey(providerId);
  if (!resolved) {
    throw new Error(
      `No key for ${spec.name}. Get one at ${spec.keyUrl}, then: ` +
        `studio provider set-key ${spec.id} <key>`,
    );
  }
  const scheme = spec.authScheme ?? ((k: string) => k);
  const headers: Record<string, string> = {
    [spec.authHeader]: scheme(resolved.key),
  };
  // Anthropic requires an explicit API version header.
  if (spec.protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";
  return headers;
}

export function statusOf(spec: ProviderSpec): ProviderStatus {
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    capabilities: spec.capabilities,
    baseUrl: baseUrlFor(spec.id),
    keyUrl: spec.keyUrl,
    configured: spec.kind === "local" ? true : hasKey(spec.id),
    keySource: spec.kind === "local" ? "none" : keySource(spec.id),
  };
}

export function listProviders(filter?: { capability?: Capability }): ProviderStatus[] {
  return PROVIDER_CATALOG.filter(
    (spec) => !filter?.capability || spec.capabilities.includes(filter.capability),
  ).map(statusOf);
}

/**
 * Cheap liveness check. For local providers this answers "is the server running?";
 * for cloud providers it also validates the key. Never throws — probe failures are
 * normal and belong in the returned status.
 */
export async function probeProvider(
  providerId: string,
  timeoutMs = 4000,
): Promise<ProviderStatus> {
  const spec = requireProvider(providerId);
  const status = statusOf(spec);

  if (!spec.probePath) {
    status.error = "No probe endpoint defined; configuration not verified.";
    return status;
  }
  if (spec.kind === "cloud" && !status.configured) {
    status.reachable = false;
    status.error = `No key configured. Get one at ${spec.keyUrl}`;
    return status;
  }

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${status.baseUrl}${spec.probePath}`, {
      headers: authHeaders(providerId),
      signal,
    });
    status.reachable = res.ok;
    if (!res.ok) {
      status.error = `HTTP ${res.status} ${res.statusText}`;
      return status;
    }
    status.models = extractModelIds(await res.json().catch(() => null));
  } catch (err) {
    status.reachable = false;
    status.error = describeProbeError(err, status.baseUrl, spec);
  }
  return status;
}

export async function probeAll(
  filter?: { kind?: ProviderSpec["kind"] },
): Promise<ProviderStatus[]> {
  const specs = PROVIDER_CATALOG.filter((s) => !filter?.kind || s.kind === filter.kind);
  return Promise.all(specs.map((s) => probeProvider(s.id)));
}

/** Pulls model ids out of the several shapes providers return. */
function extractModelIds(body: unknown): string[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;
  // OpenAI-compatible: { data: [{ id }] }. Ollama: { models: [{ name }] }.
  const list = Array.isArray(obj.data)
    ? obj.data
    : Array.isArray(obj.models)
      ? obj.models
      : undefined;
  if (!list) return undefined;
  return list
    .map((m) =>
      typeof m === "object" && m
        ? ((m as Record<string, unknown>).id ?? (m as Record<string, unknown>).name)
        : undefined,
    )
    .filter((id): id is string => typeof id === "string")
    .slice(0, 200);
}

function describeProbeError(err: unknown, baseUrl: string, spec: ProviderSpec): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("timed out") || msg.includes("aborted")) {
    return `Timed out reaching ${baseUrl}`;
  }
  if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
    return spec.kind === "local"
      ? `Nothing listening at ${baseUrl}. Start ${spec.name}, or point elsewhere: ` +
          `studio provider set-url ${spec.id} <url>`
      : `Could not reach ${baseUrl}`;
  }
  return msg;
}
