import { listProviders, probeAll, probeProvider, setBaseUrl, setDefault, getDefault } from "../providers/registry.ts";
import { setKey, deleteKey, maskKey } from "../providers/keystore.ts";
import { PROVIDER_CATALOG } from "../providers/catalog.ts";
import type { Capability } from "../providers/types.ts";
import { listCharacters, requireCharacter } from "../characters/store.ts";
import { interact } from "../mind/mind.ts";
import { dream } from "../mind/dream.ts";
import { tick } from "../mind/heartbeat.ts";
import { beliefs, episodes, semantic } from "../mind/memory.ts";
import { listProjects, getProject } from "../ingest/manifest.ts";
import { listJobs, summary, requireJob, renderRequest, retry } from "../assets/queue.ts";

/**
 * The JSON API behind the local console. Every handler is a plain function of a
 * parsed body so it can be unit-tested without a socket, and so the CLI and the UI
 * exercise exactly the same code paths.
 */

export interface ApiRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const bad = (message: string): ApiResponse => ({ status: 400, body: { error: message } });

export async function handle(req: ApiRequest): Promise<ApiResponse> {
  const { method, path, body } = req;

  try {
    // ---------------------------------------------------------- providers
    if (path === "/api/providers" && method === "GET") {
      return ok({
        providers: listProviders().map((p) => ({ ...p, masked: maskKey(p.id) })),
        defaults: Object.fromEntries(
          (["text", "image", "video", "voice", "mesh3d", "embed"] as Capability[]).map(
            (c) => [c, getDefault(c) ?? null],
          ),
        ),
      });
    }

    if (path === "/api/providers/probe" && method === "POST") {
      const id = str(body.id);
      return ok({ statuses: id ? [await probeProvider(id)] : await probeAll() });
    }

    if (path === "/api/providers/key" && method === "POST") {
      const id = str(body.id);
      const key = str(body.key);
      if (!id) return bad("id is required");
      if (!key) {
        deleteKey(id);
        return ok({ id, cleared: true });
      }
      setKey(id, key);
      return ok({ id, masked: maskKey(id) });
    }

    if (path === "/api/providers/url" && method === "POST") {
      const id = str(body.id);
      const url = str(body.url);
      if (!id || !url) return bad("id and url are required");
      setBaseUrl(id, url);
      return ok({ id, url });
    }

    if (path === "/api/providers/default" && method === "POST") {
      const capability = str(body.capability) as Capability | undefined;
      const id = str(body.id);
      if (!capability || !id) return bad("capability and id are required");
      setDefault(capability, id);
      return ok({ capability, id });
    }

    // --------------------------------------------------------- characters
    if (path === "/api/characters" && method === "GET") {
      return ok({
        characters: listCharacters().map((c) => ({
          slug: c.slug,
          name: c.name,
          tagline: c.tagline,
          contentRating: c.contentRating,
          likenessOrigin: c.likeness.origin,
          motions: c.motions.length,
          mood: semantic(c.slug).mood,
          episodeCount: episodes(c.slug).length,
          beliefCount: beliefs(c.slug).length,
        })),
      });
    }

    if (path === "/api/character" && method === "GET") {
      const slug = str(body.slug);
      if (!slug) return bad("slug is required");
      const character = requireCharacter(slug);
      return ok({
        character,
        mood: semantic(slug).mood,
        beliefs: [...beliefs(slug)].sort((a, b) => b.confidence - a.confidence),
        recentEpisodes: episodes(slug).slice(-40).reverse(),
      });
    }

    if (path === "/api/character/say" && method === "POST") {
      const slug = str(body.slug);
      const text = str(body.text);
      if (!slug || !text) return bad("slug and text are required");
      const result = await interact(slug, text, { speaker: str(body.speaker) ?? "visitor" });
      return ok(result);
    }

    if (path === "/api/character/tick" && method === "POST") {
      const slug = str(body.slug);
      if (!slug) return bad("slug is required");
      return ok(await tick(slug));
    }

    if (path === "/api/character/dream" && method === "POST") {
      const slug = str(body.slug);
      if (!slug) return bad("slug is required");
      return ok(await dream(slug, { force: body.force === true }));
    }

    // ------------------------------------------------------------ ingest
    if (path === "/api/projects" && method === "GET") {
      return ok({
        projects: listProjects().map((p) => ({
          slug: p.slug,
          name: p.name,
          sourceDir: p.sourceDir,
          mediaCount: p.media.length,
          shotCount: p.media.reduce((n, m) => n + m.shots.length, 0),
        })),
      });
    }

    if (path === "/api/project" && method === "GET") {
      const slug = str(body.slug);
      if (!slug) return bad("slug is required");
      const project = getProject(slug);
      return project ? ok({ project }) : bad(`No project "${slug}"`);
    }

    // ------------------------------------------------------------ assets
    if (path === "/api/jobs" && method === "GET") {
      return ok({ jobs: listJobs(), summary: summary() });
    }

    if (path === "/api/job/request" && method === "POST") {
      const id = str(body.id);
      if (!id) return bad("id is required");
      return ok(renderRequest(requireJob(id)));
    }

    if (path === "/api/job/retry" && method === "POST") {
      const id = str(body.id);
      if (!id) return bad("id is required");
      return ok(retry(id));
    }

    // -------------------------------------------------------------- meta
    if (path === "/api/catalog" && method === "GET") {
      return ok({
        catalog: PROVIDER_CATALOG.map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          capabilities: p.capabilities,
          keyUrl: p.keyUrl,
          envVar: p.envVar,
          notes: p.notes,
        })),
      });
    }

    return { status: 404, body: { error: `No route ${method} ${path}` } };
  } catch (err) {
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
