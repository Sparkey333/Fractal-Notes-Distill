import { join } from "node:path";
import { writeFileSync, renameSync } from "node:fs";
import { characterDir } from "../core/paths.ts";
import { appendJsonl, readJsonl, readJson, writeJson } from "../core/store.ts";
import { newId } from "../core/ids.ts";

/**
 * Two-tier memory.
 *
 * Episodic memory is an append-only log of things that happened: what was said,
 * what the character noticed, what it did on a heartbeat tick. It is cheap to
 * write and grows without bound, so it is never loaded wholesale into a prompt.
 *
 * Semantic memory is the distillate: durable beliefs the character holds, each
 * with a confidence and a pointer back to the episodes that produced it. The dream
 * routine is what moves material from the first tier to the second.
 *
 * Retrieval scores on recency, salience and lexical overlap together. That is
 * deliberately unsophisticated — it needs no embedding provider, so a character
 * stays fully functional on a laptop with nothing but Ollama running.
 */

export type EpisodeKind =
  | "interaction" // exchange with a person
  | "observation" // something the character noticed
  | "action" // something the character did
  | "reflection" // produced by a heartbeat tick
  | "dream"; // produced by consolidation

export interface Episode {
  id: string;
  at: string;
  kind: EpisodeKind;
  /** What happened, in the character's own framing. */
  content: string;
  /** Who else was involved, if anyone. */
  withWhom?: string;
  /** 0–1. Drives retrieval priority and what survives consolidation. */
  salience: number;
  /** Set once this episode has been folded into semantic memory. */
  consolidatedAt?: string;
  tags?: string[];
}

export interface Belief {
  id: string;
  /** A standing fact or disposition, e.g. "Distrusts anyone who flatters her." */
  statement: string;
  /** 0–1, raised by corroboration and lowered by contradiction. */
  confidence: number;
  /** Episode ids this was drawn from. */
  sources: string[];
  firstSeenAt: string;
  updatedAt: string;
  tags?: string[];
}

interface SemanticFile {
  beliefs: Belief[];
  /** Slow-moving affective state, nudged by ticks and interactions. */
  mood: Mood;
}

export interface Mood {
  /** -1 (miserable) to 1 (elated). */
  valence: number;
  /** 0 (dormant) to 1 (keyed up). */
  arousal: number;
  updatedAt: string;
}

const episodeFile = (slug: string) => join(characterDir(slug), "memory.jsonl");
const semanticFile = (slug: string) => join(characterDir(slug), "semantic.json");

const EMPTY_SEMANTIC: SemanticFile = {
  beliefs: [],
  mood: { valence: 0, arousal: 0.3, updatedAt: new Date(0).toISOString() },
};

export function remember(
  slug: string,
  input: Omit<Episode, "id" | "at"> & { at?: string },
): Episode {
  const episode: Episode = {
    ...input,
    id: newId("ep"),
    at: input.at ?? new Date().toISOString(),
    salience: clamp01(input.salience),
  };
  appendJsonl(episodeFile(slug), episode);
  return episode;
}

export function episodes(slug: string): Episode[] {
  return readJsonl<Episode>(episodeFile(slug));
}

export function unconsolidated(slug: string): Episode[] {
  return episodes(slug).filter((e) => !e.consolidatedAt && e.kind !== "dream");
}

/**
 * Rewrites the log with consolidation stamps applied. Written to a temp file and
 * renamed, so an interrupted rewrite leaves the previous log intact rather than a
 * half-truncated one — this is the only operation that rewrites episodic memory
 * in place, so it is the only one that can lose history.
 */
export function markConsolidated(slug: string, episodeIds: string[]): void {
  const marked = new Set(episodeIds);
  const at = new Date().toISOString();
  const all = episodes(slug).map((e) =>
    marked.has(e.id) ? { ...e, consolidatedAt: at } : e,
  );
  const file = episodeFile(slug);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
  renameSync(tmp, file);
}

export function semantic(slug: string): SemanticFile {
  return readJson<SemanticFile>(semanticFile(slug), EMPTY_SEMANTIC);
}

export function beliefs(slug: string): Belief[] {
  return semantic(slug).beliefs;
}

/**
 * Folds a belief in. A near-duplicate statement corroborates the existing belief
 * (confidence up, sources merged) instead of creating a second copy — otherwise
 * repeated dreams would silently inflate the belief set.
 */
export function upsertBelief(
  slug: string,
  input: { statement: string; confidence: number; sources: string[]; tags?: string[] },
): Belief {
  const store = semantic(slug);
  const now = new Date().toISOString();
  const existing = store.beliefs.find((b) => similar(b.statement, input.statement));

  let result: Belief;
  if (existing) {
    result = {
      ...existing,
      confidence: clamp01(existing.confidence + (1 - existing.confidence) * 0.3),
      sources: [...new Set([...existing.sources, ...input.sources])].slice(-50),
      tags: [...new Set([...(existing.tags ?? []), ...(input.tags ?? [])])],
      updatedAt: now,
    };
    store.beliefs = store.beliefs.map((b) => (b.id === existing.id ? result : b));
  } else {
    result = {
      id: newId("belief"),
      statement: input.statement.trim(),
      confidence: clamp01(input.confidence),
      sources: input.sources,
      tags: input.tags,
      firstSeenAt: now,
      updatedAt: now,
    };
    store.beliefs.push(result);
  }
  writeJson(semanticFile(slug), store);
  return result;
}

export function setMood(slug: string, mood: Partial<Omit<Mood, "updatedAt">>): Mood {
  const store = semantic(slug);
  const next: Mood = {
    valence: clamp(mood.valence ?? store.mood.valence, -1, 1),
    arousal: clamp01(mood.arousal ?? store.mood.arousal),
    updatedAt: new Date().toISOString(),
  };
  writeJson(semanticFile(slug), { ...store, mood: next });
  return next;
}

/** Pulls mood toward baseline. Called each tick so spikes decay on their own. */
export function decayMood(slug: string, rate = 0.12): Mood {
  const { mood } = semantic(slug);
  return setMood(slug, {
    valence: mood.valence * (1 - rate),
    arousal: 0.3 + (mood.arousal - 0.3) * (1 - rate),
  });
}

export interface RecallOptions {
  /** Query text. Omit to retrieve purely on recency and salience. */
  query?: string;
  limit?: number;
  kinds?: EpisodeKind[];
  /** Half-life in hours for the recency term. */
  halfLifeHours?: number;
}

export function recall(slug: string, opts: RecallOptions = {}): Episode[] {
  const { query, limit = 8, kinds, halfLifeHours = 72 } = opts;
  const now = Date.now();
  const terms = query ? tokenize(query) : [];

  return episodes(slug)
    .filter((e) => !kinds || kinds.includes(e.kind))
    .map((e) => {
      const ageHours = (now - Date.parse(e.at)) / 3_600_000;
      const recency = Math.pow(0.5, ageHours / halfLifeHours);
      const overlap = terms.length > 0 ? lexicalOverlap(terms, tokenize(e.content)) : 0;
      // Salience dominates, recency breaks ties, query relevance can override both.
      const score = e.salience * 0.4 + recency * 0.25 + overlap * 0.35;
      return { episode: e, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.episode);
}

/**
 * Assembles the working context handed to the model: who the character is now,
 * what they believe, how they feel, and what is most relevant to the moment.
 */
export function workingContext(slug: string, query?: string, limit = 8): string {
  const store = semantic(slug);
  const relevant = recall(slug, { query, limit });
  const top = [...store.beliefs]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 12);

  const sections: string[] = [];
  if (top.length > 0) {
    sections.push(
      "What you hold to be true:\n" +
        top
          .map((b) => `- ${b.statement} (confidence ${b.confidence.toFixed(2)})`)
          .join("\n"),
    );
  }
  sections.push(
    `How you feel right now: valence ${store.mood.valence.toFixed(2)}, ` +
      `arousal ${store.mood.arousal.toFixed(2)}.`,
  );
  if (relevant.length > 0) {
    sections.push(
      "What comes to mind:\n" +
        relevant
          .map((e) => `- [${e.at.slice(0, 16).replace("T", " ")}] ${e.content}`)
          .join("\n"),
    );
  }
  return sections.join("\n\n");
}

// ---------------------------------------------------------------- scoring bits

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "was", "were", "be", "been", "to",
  "of", "in", "on", "at", "for", "with", "that", "this", "it", "as", "i", "you",
  "he", "she", "they", "we", "her", "his", "their", "my", "me", "him", "them",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function lexicalOverlap(queryTerms: string[], docTerms: string[]): number {
  if (queryTerms.length === 0 || docTerms.length === 0) return 0;
  const doc = new Set(docTerms);
  const hits = queryTerms.filter((t) => doc.has(t)).length;
  return hits / queryTerms.length;
}

/** Jaccard over content words. Cheap near-duplicate test for belief merging. */
function similar(a: string, b: string, threshold = 0.6): boolean {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return false;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.size + sb.size - shared) >= threshold;
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}
