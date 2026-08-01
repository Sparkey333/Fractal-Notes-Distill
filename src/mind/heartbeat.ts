import { complete } from "../providers/chat.ts";
import { listCharacters, requireCharacter } from "../characters/store.ts";
import type { Character } from "../characters/schema.ts";
import { buildSystemPrompt } from "./mind.ts";
import { decayMood, remember, unconsolidated } from "./memory.ts";
import { dream } from "./dream.ts";

/**
 * The heartbeat: what a character does when nobody is talking to it.
 *
 * Each tick the character has one unprompted thought, its mood relaxes toward
 * baseline, and — once the backlog crosses the character's threshold — it dreams.
 * Without this a character is a pure function of its last prompt; with it, time
 * passing actually does something, which is what makes a returning visitor find
 * someone who has moved on rather than someone frozen mid-sentence.
 *
 * Ticks are cheap by design (one short completion) so a roster can idle on a local
 * model indefinitely.
 */

export interface TickResult {
  slug: string;
  at: string;
  thought?: string;
  dreamed?: { episodesProcessed: number; beliefsFormed: number };
  error?: string;
}

export async function tick(slug: string): Promise<TickResult> {
  const character = requireCharacter(slug);
  const at = new Date().toISOString();
  const result: TickResult = { slug, at };

  try {
    const thought = await idleThought(character);
    if (thought) {
      remember(slug, { kind: "reflection", content: thought, salience: 0.25 });
      result.thought = thought;
    }
    decayMood(slug);

    const backlog = unconsolidated(slug).length;
    const threshold = character.mind.dreamAfterEpisodes ?? 40;
    if (backlog >= threshold) {
      const d = await dream(slug);
      result.dreamed = {
        episodesProcessed: d.episodesProcessed,
        beliefsFormed: d.beliefsFormed,
      };
    }
  } catch (err) {
    // A tick failing must never take the scheduler down — a local model being
    // temporarily unloaded is an ordinary condition, not an outage.
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

async function idleThought(character: Character): Promise<string | undefined> {
  const response = await complete({
    provider: character.mind.provider,
    model: character.mind.model,
    temperature: Math.min(1, (character.mind.temperature ?? 0.8) + 0.15),
    maxTokens: 160,
    messages: [
      { role: "system", content: buildSystemPrompt(character) },
      {
        role: "user",
        content:
          "Nobody is here. Have one unprompted thought — something you notice, " +
          "want, remember, or are turning over. One or two sentences, first person. " +
          "Do not greet anyone and do not ask a question.",
      },
    ],
  });
  const thought = response.text.trim();
  return thought.length > 0 ? thought : undefined;
}

export interface SchedulerOptions {
  /** Restrict to these slugs. Defaults to every character with a heartbeat. */
  slugs?: string[];
  /** Called after each tick, for logging or UI updates. */
  onTick?: (result: TickResult) => void;
  /** Scheduler resolution. Characters tick on their own configured rate. */
  resolutionMs?: number;
}

export interface Scheduler {
  stop: () => void;
  /** Slugs currently being ticked, with their interval in minutes. */
  roster: () => { slug: string; everyMinutes: number }[];
}

/**
 * Runs heartbeats for a roster. Each character's rate comes from its own
 * `mind.heartbeatPerHour`; the scheduler wakes on a fixed resolution and ticks
 * whoever is due, so one slow character cannot delay the others.
 */
export function startHeartbeat(opts: SchedulerOptions = {}): Scheduler {
  const resolutionMs = opts.resolutionMs ?? 60_000;
  const nextDue = new Map<string, number>();
  const inFlight = new Set<string>();

  const due = (): { character: Character; intervalMs: number }[] =>
    listCharacters()
      .filter((c) => (opts.slugs ? opts.slugs.includes(c.slug) : true))
      .filter((c) => (c.mind.heartbeatPerHour ?? 0) > 0)
      .map((c) => ({
        character: c,
        intervalMs: 3_600_000 / (c.mind.heartbeatPerHour ?? 1),
      }));

  const run = async () => {
    const now = Date.now();
    for (const { character, intervalMs } of due()) {
      const slug = character.slug;
      if (inFlight.has(slug)) continue; // a slow tick must not stack up
      const when = nextDue.get(slug);
      if (when === undefined) {
        // Stagger first ticks so a large roster does not stampede the backend.
        nextDue.set(slug, now + Math.floor(intervalMs * Math.random()));
        continue;
      }
      if (now < when) continue;

      inFlight.add(slug);
      nextDue.set(slug, now + intervalMs);
      void tick(slug)
        .then((result) => opts.onTick?.(result))
        .finally(() => inFlight.delete(slug));
    }
  };

  void run();
  const timer = setInterval(() => void run(), resolutionMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    roster: () =>
      due().map(({ character, intervalMs }) => ({
        slug: character.slug,
        everyMinutes: Math.round(intervalMs / 60_000),
      })),
  };
}
