import type { LikenessDeclaration } from "../policy/likeness.ts";

/**
 * A character is a durable design document plus the configuration that animates
 * it. Everything here is authored data — the mind layer reads it, never rewrites
 * it. Learned material accumulates in memory (see `mind/memory.ts`) so a character
 * can be retrained or rolled back without losing its design.
 */

/**
 * Content tier a character may appear in. The studio uses this to gate routing and
 * to pick which of the operator's own scene templates apply; it does not itself
 * carry any scene text.
 */
export type ContentRating = "general" | "suggestive" | "adult" | "horror";

export interface Appearance {
  /** Written design brief. This is the source of truth for image generation. */
  brief: string;
  /** Short tags that must survive every render: build, palette, silhouette. */
  anchors: string[];
  /** Wardrobe and prop defaults, referenced by asset jobs. */
  wardrobe?: string[];
  /** Seed/reference asset ids that lock visual consistency across renders. */
  referenceAssetIds?: string[];
}

export interface VoiceConfig {
  /** Provider id from the catalog, e.g. "elevenlabs". */
  provider?: string;
  /** Provider-side voice identifier. */
  voiceId?: string;
  /** How the character sounds, in words. Drives synthesis when no voiceId is set. */
  description?: string;
  /**
   * Non-verbal vocalisation set the performance layer may draw on — breath,
   * laughter, effort, and so on. Named here; the audio itself is generated or
   * recorded per production and stored as assets.
   */
  vocalisations?: string[];
}

export interface MindConfig {
  /** Provider id for the character's reasoning. Falls back to the text default. */
  provider?: string;
  model: string;
  temperature?: number;
  /** Ticks per hour while idle. Zero disables the heartbeat for this character. */
  heartbeatPerHour?: number;
  /** Consolidate memory after this many unprocessed episodes. */
  dreamAfterEpisodes?: number;
}

/** A motion the character knows how to perform, and where its reference lives. */
export interface MotionEntry {
  id: string;
  /** Short label, e.g. "shoulder-roll", "head-tilt-listen". */
  name: string;
  /** What the motion looks like, for prompt assembly. */
  description: string;
  /** Ingest shot ids this was observed in, for timing reference. */
  sourceShotIds?: string[];
  /** Generated animation asset ids that realise this motion. */
  assetIds?: string[];
  /** Seconds. Taken from source shots when available. */
  durationSec?: number;
  tags?: string[];
}

export interface Character {
  id: string;
  slug: string;
  name: string;
  /** One line, for rosters and pickers. */
  tagline?: string;

  persona: {
    /** Who they are. Free prose; the mind's system prompt is built from this. */
    summary: string;
    /** Stable traits, e.g. "wry", "guarded", "quick to bore". */
    traits: string[];
    /** Cadence, vocabulary, verbal tics. */
    speechStyle?: string;
    backstory?: string;
    /** Things this character will not do, in their own fiction. */
    boundaries?: string[];
  };

  appearance: Appearance;
  likeness: LikenessDeclaration;
  voice?: VoiceConfig;
  mind: MindConfig;
  motions: MotionEntry[];

  contentRating: ContentRating;
  /** Free-form operator tags: production, scene, cohort. */
  tags?: string[];

  createdAt: string;
  updatedAt: string;
  /** Bumped on every save, so callers can detect concurrent edits. */
  revision: number;
}

export interface CharacterDraft {
  name: string;
  tagline?: string;
  persona: Character["persona"];
  appearance: Appearance;
  likeness: LikenessDeclaration;
  voice?: VoiceConfig;
  mind?: Partial<MindConfig>;
  contentRating?: ContentRating;
  tags?: string[];
}

export const DEFAULT_MIND: MindConfig = {
  model: "llama3.2",
  temperature: 0.8,
  heartbeatPerHour: 4,
  dreamAfterEpisodes: 40,
};

/** Structural validation. Policy checks live in `policy/likeness.ts`. */
export function validateDraft(draft: CharacterDraft): string[] {
  const errors: string[] = [];
  if (!draft.name?.trim()) errors.push("name is required");
  if (!draft.persona?.summary?.trim()) errors.push("persona.summary is required");
  if (!draft.appearance?.brief?.trim()) errors.push("appearance.brief is required");
  if (!draft.likeness?.origin) errors.push("likeness.origin is required");
  if (
    draft.appearance?.anchors !== undefined &&
    !Array.isArray(draft.appearance.anchors)
  ) {
    errors.push("appearance.anchors must be an array");
  }
  return errors;
}
