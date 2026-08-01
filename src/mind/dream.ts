import { complete, parseJsonLoose } from "../providers/chat.ts";
import { requireCharacter } from "../characters/store.ts";
import {
  markConsolidated,
  remember,
  unconsolidated,
  upsertBelief,
  beliefs,
  decayMood,
  type Episode,
} from "./memory.ts";

/**
 * Consolidation — the studio's "dreaming" routine.
 *
 * A character accumulates episodes far faster than any prompt can hold. Dreaming
 * runs offline over the unconsolidated backlog and distils it into durable
 * beliefs, then stamps those episodes as processed. The episodes are kept, not
 * deleted: the log is the ground truth and beliefs are a lossy index over it, so a
 * bad consolidation can always be discarded and re-derived.
 *
 * This is the mechanism by which a character actually changes over time. Two
 * characters with identical definitions but different histories will diverge, and
 * that divergence lives entirely in semantic memory.
 */

export interface DreamResult {
  slug: string;
  episodesProcessed: number;
  beliefsFormed: number;
  /** The character's own account of the consolidation, stored as an episode. */
  narrative: string;
  skipped?: string;
}

interface DreamPayload {
  beliefs?: { statement: string; confidence?: number; tags?: string[] }[];
  narrative?: string;
}

export interface DreamOptions {
  /** Consolidate even when the backlog is below the character's threshold. */
  force?: boolean;
  /** Cap episodes per pass, to bound prompt size on a long backlog. */
  batchSize?: number;
  model?: string;
  provider?: string;
}

export async function dream(slug: string, opts: DreamOptions = {}): Promise<DreamResult> {
  const character = requireCharacter(slug);
  const backlog = unconsolidated(slug);
  const threshold = character.mind.dreamAfterEpisodes ?? 40;

  if (!opts.force && backlog.length < threshold) {
    return {
      slug,
      episodesProcessed: 0,
      beliefsFormed: 0,
      narrative: "",
      skipped: `${backlog.length} unconsolidated episodes; threshold is ${threshold}.`,
    };
  }
  if (backlog.length === 0) {
    return {
      slug,
      episodesProcessed: 0,
      beliefsFormed: 0,
      narrative: "",
      skipped: "Nothing to consolidate.",
    };
  }

  // Most salient first, so a truncated batch keeps what matters.
  const batch = [...backlog]
    .sort((a, b) => b.salience - a.salience)
    .slice(0, opts.batchSize ?? 60);

  const existing = beliefs(slug)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 20)
    .map((b) => `- ${b.statement}`)
    .join("\n");

  const result = await complete({
    provider: opts.provider ?? character.mind.provider,
    model: opts.model ?? character.mind.model,
    temperature: 0.6,
    json: true,
    messages: [
      {
        role: "system",
        content:
          `You are the sleeping mind of ${character.name}. You are reviewing the ` +
          `day's experiences and deciding what is worth keeping as a lasting belief ` +
          `about yourself, about the people you have met, and about how the world ` +
          `treats you.\n\n` +
          `Return a JSON object with exactly two fields:\n` +
          `  "beliefs": an array of at most 6 objects, each { "statement": string, ` +
          `"confidence": number between 0 and 1, "tags": string[] }\n` +
          `  "narrative": a short first-person paragraph, in your own voice, ` +
          `describing the dream.\n\n` +
          `Write beliefs as standing dispositions, not as a recap of events. ` +
          `Prefer few, sharp beliefs over many vague ones. Do not restate a belief ` +
          `you already hold unless the new experience genuinely strengthens it.`,
      },
      {
        role: "user",
        content:
          (existing ? `Beliefs you already hold:\n${existing}\n\n` : "") +
          `What happened:\n${batch.map(renderEpisode).join("\n")}`,
      },
    ],
  });

  const payload = parseJsonLoose<DreamPayload>(result.text);
  const sources = batch.map((e) => e.id);

  let formed = 0;
  for (const belief of payload.beliefs ?? []) {
    if (!belief?.statement?.trim()) continue;
    upsertBelief(slug, {
      statement: belief.statement,
      confidence: typeof belief.confidence === "number" ? belief.confidence : 0.5,
      sources,
      tags: belief.tags,
    });
    formed++;
  }

  const narrative = payload.narrative?.trim() ?? "";
  if (narrative) {
    remember(slug, { kind: "dream", content: narrative, salience: 0.5 });
  }

  markConsolidated(slug, sources);
  decayMood(slug, 0.4); // sleep evens out the day

  return {
    slug,
    episodesProcessed: batch.length,
    beliefsFormed: formed,
    narrative,
  };
}

function renderEpisode(e: Episode): string {
  const when = e.at.slice(0, 16).replace("T", " ");
  return `- [${when}] (${e.kind}, salience ${e.salience.toFixed(2)}) ${e.content}`;
}
