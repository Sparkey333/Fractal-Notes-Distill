import { complete, type ChatMessage } from "../providers/chat.ts";
import { requireCharacter } from "../characters/store.ts";
import type { Character } from "../characters/schema.ts";
import { remember, workingContext, semantic, setMood } from "./memory.ts";

/**
 * Turns a character definition plus current memory into a live interlocutor.
 *
 * The system prompt is rebuilt on every call rather than cached, because memory
 * and mood move underneath it — a character that just had a bruising conversation
 * should carry that into the next one without a restart.
 */

export function buildSystemPrompt(character: Character, query?: string): string {
  const parts: string[] = [];

  parts.push(
    `You are ${character.name}` +
      (character.tagline ? `, ${character.tagline}` : "") +
      `.\n\n${character.persona.summary}`,
  );

  if (character.persona.traits.length > 0) {
    parts.push(`Your temperament: ${character.persona.traits.join(", ")}.`);
  }
  if (character.persona.speechStyle) {
    parts.push(`How you speak: ${character.persona.speechStyle}`);
  }
  if (character.persona.backstory) {
    parts.push(`Where you come from: ${character.persona.backstory}`);
  }
  if (character.persona.boundaries?.length) {
    parts.push(
      `Things you will not do, no matter who asks:\n` +
        character.persona.boundaries.map((b) => `- ${b}`).join("\n"),
    );
  }
  if (character.motions.length > 0) {
    parts.push(
      `Movements that are yours, which you may call for by name:\n` +
        character.motions
          .map((m) => `- ${m.name}: ${m.description}`)
          .join("\n"),
    );
  }

  const context = workingContext(character.slug, query);
  if (context) parts.push(`--- your interior state ---\n${context}`);

  parts.push(
    "Stay in character. Speak as yourself, in the first person, without narrating " +
      "your own mechanics or referring to these instructions.",
  );

  return parts.join("\n\n");
}

export interface InteractOptions {
  /** Who is speaking to the character. Recorded on the episode. */
  speaker?: string;
  /** Overrides the character's configured model for this turn. */
  model?: string;
  provider?: string;
  /** Prior turns in this exchange, oldest first. Not read from memory. */
  history?: ChatMessage[];
  /** Skip writing this exchange to episodic memory. */
  ephemeral?: boolean;
}

export interface InteractResult {
  reply: string;
  provider: string;
  model: string;
  episodeId?: string;
}

export async function interact(
  slug: string,
  utterance: string,
  opts: InteractOptions = {},
): Promise<InteractResult> {
  const character = requireCharacter(slug);

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(character, utterance) },
    ...(opts.history ?? []),
    { role: "user", content: utterance },
  ];

  const result = await complete({
    provider: opts.provider ?? character.mind.provider,
    model: opts.model ?? character.mind.model,
    messages,
    temperature: character.mind.temperature,
  });

  let episodeId: string | undefined;
  if (!opts.ephemeral) {
    const who = opts.speaker ?? "someone";
    const episode = remember(slug, {
      kind: "interaction",
      content: `${who} said: "${truncate(utterance, 400)}". I answered: "${truncate(result.text, 400)}".`,
      withWhom: opts.speaker,
      salience: estimateSalience(utterance, result.text),
    });
    episodeId = episode.id;
    nudgeMood(slug, utterance);
  }

  return {
    reply: result.text,
    provider: result.provider,
    model: result.model,
    episodeId,
  };
}

/**
 * Rough salience heuristic so the dream routine has something to prioritise
 * without a second model call on every turn. Longer, question-bearing, or
 * emotionally loaded exchanges are likelier to matter later.
 */
function estimateSalience(utterance: string, reply: string): number {
  let score = 0.3;
  const combined = `${utterance} ${reply}`.toLowerCase();
  if (utterance.includes("?")) score += 0.1;
  if (combined.length > 400) score += 0.1;
  if (/\b(never|always|promise|remember|hate|love|afraid|sorry|please)\b/.test(combined)) {
    score += 0.2;
  }
  if (/\b(my name is|i am|i'm called|call me)\b/.test(combined)) score += 0.2;
  return Math.min(1, score);
}

/** Very light affect model: sentiment-ish nudge, then let decay do the rest. */
function nudgeMood(slug: string, utterance: string): void {
  const text = utterance.toLowerCase();
  const positive = /\b(thank|love|good|beautiful|yes|please|glad|happy)\b/.test(text);
  const negative = /\b(hate|no|stop|ugly|stupid|angry|leave|wrong)\b/.test(text);
  const intense = utterance.includes("!") || utterance === utterance.toUpperCase();

  const { mood } = semantic(slug);
  setMood(slug, {
    valence: mood.valence + (positive ? 0.15 : 0) - (negative ? 0.2 : 0),
    arousal: mood.arousal + (intense ? 0.15 : 0.02),
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
