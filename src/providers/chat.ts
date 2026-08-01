import { requireProvider } from "./catalog.ts";
import { authHeaders, baseUrlFor, getDefault } from "./registry.ts";

/**
 * One `complete()` across every text backend. The mind layer calls this and stays
 * ignorant of whether it is talking to Ollama on localhost or a cloud endpoint,
 * which is what makes a character portable between machines.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  /** Provider id. Defaults to the configured `text` default provider. */
  provider?: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Nudges the backend toward emitting a bare JSON object. */
  json?: boolean;
  timeoutMs?: number;
}

export interface CompleteResult {
  text: string;
  provider: string;
  model: string;
  /** Present when the backend reports usage. */
  inputTokens?: number;
  outputTokens?: number;
}

export async function complete(opts: CompleteOptions): Promise<CompleteResult> {
  const providerId = opts.provider ?? getDefault("text");
  if (!providerId) {
    throw new Error(
      "No text provider selected. Set one with: studio provider use text <id> " +
        "(e.g. `studio provider use text ollama`).",
    );
  }
  const spec = requireProvider(providerId);
  if (!spec.capabilities.includes("text")) {
    throw new Error(`${spec.name} does not serve text completions.`);
  }

  const signal = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const headers = {
    "content-type": "application/json",
    ...authHeaders(providerId),
  };
  const base = baseUrlFor(providerId);

  switch (spec.protocol) {
    case "ollama":
      return ollamaComplete(base, headers, signal, providerId, opts);
    case "anthropic":
      return anthropicComplete(base, headers, signal, providerId, opts);
    case "openai-compatible":
      return openAiComplete(base, headers, signal, providerId, opts);
    default:
      throw new Error(
        `${spec.name} has no text adapter (protocol "${spec.protocol}").`,
      );
  }
}

async function post(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { method: "POST", ...init });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 600);
    throw new Error(`${url} → HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

async function openAiComplete(
  base: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  providerId: string,
  opts: CompleteOptions,
): Promise<CompleteResult> {
  const body = await post(`${base}/chat/completions`, {
    headers,
    signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const b = body as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: b.choices?.[0]?.message?.content ?? "",
    provider: providerId,
    model: opts.model,
    inputTokens: b.usage?.prompt_tokens,
    outputTokens: b.usage?.completion_tokens,
  };
}

async function ollamaComplete(
  base: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  providerId: string,
  opts: CompleteOptions,
): Promise<CompleteResult> {
  const body = await post(`${base}/api/chat`, {
    headers,
    signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: false,
      ...(opts.json ? { format: "json" } : {}),
      options: {
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { num_predict: opts.maxTokens } : {}),
      },
    }),
  });
  const b = body as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  return {
    text: b.message?.content ?? "",
    provider: providerId,
    model: opts.model,
    inputTokens: b.prompt_eval_count,
    outputTokens: b.eval_count,
  };
}

async function anthropicComplete(
  base: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  providerId: string,
  opts: CompleteOptions,
): Promise<CompleteResult> {
  // Anthropic carries the system prompt out-of-band rather than as a message.
  const system = opts.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = opts.messages.filter((m) => m.role !== "system");

  const body = await post(`${base}/messages`, {
    headers,
    signal,
    body: JSON.stringify({
      model: opts.model,
      ...(system ? { system } : {}),
      messages: turns,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens ?? 4096,
    }),
  });
  const b = body as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    text: (b.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join(""),
    provider: providerId,
    model: opts.model,
    inputTokens: b.usage?.input_tokens,
    outputTokens: b.usage?.output_tokens,
  };
}

/**
 * Parses a JSON object out of a completion, tolerating the fenced code blocks and
 * leading prose that smaller local models habitually add.
 */
export function parseJsonLoose<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    }
    throw new Error(`Model did not return JSON. Got: ${text.slice(0, 200)}`);
  }
}
