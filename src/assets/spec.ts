import type { Character } from "../characters/schema.ts";
import type { Shot } from "../ingest/manifest.ts";

/**
 * Asset specs describe *what to make* independently of *who makes it*. A spec is
 * durable, reviewable and diffable; the provider adapter that fulfils it is
 * swappable. That separation is what lets the same character sheet be rendered on
 * a local ComfyUI graph today and a hosted model tomorrow without redesigning the
 * character.
 */

export type AssetKind =
  | "reference" // canonical character image; locks appearance for everything else
  | "expression" // one face/emotion state
  | "pose" // one body position
  | "animation" // a motion clip
  | "prop" // an object the character interacts with
  | "environment" // a set or backdrop
  | "voiceline" // synthesized speech or vocalisation
  | "mesh3d"; // 3D asset

export type AssetStatus = "draft" | "queued" | "running" | "complete" | "failed";

/**
 * How a prop behaves when a character interacts with it. Props are the join
 * between the character layer and the scene layer: the character's motion
 * vocabulary supplies the verb, the prop's affordances supply what the verb can
 * be applied to.
 */
export interface PropAffordances {
  /** Verbs the prop accepts, e.g. "grip", "lift", "strike", "open". */
  accepts: string[];
  /** Physical character that shapes how motion reads against it. */
  material?: "rigid" | "soft" | "elastic" | "granular" | "fluid" | "articulated";
  /** Roughly how heavy it plays, 0–1. Drives effort in the animation prompt. */
  weight?: number;
  /** Named states the prop can be in, e.g. "closed" -> "open". */
  states?: string[];
  /** Other prop ids this one connects to, for composite builds. */
  composesWith?: string[];
}

export interface AssetSpec {
  id: string;
  kind: AssetKind;
  /** Character this belongs to. Absent for standalone props and environments. */
  characterSlug?: string;
  /** Short handle, unique within a character. */
  name: string;

  /** The assembled generation prompt. Built by buildPrompt(). */
  prompt: string;
  negativePrompt?: string;

  /** Provider id. Falls back to the configured default for the capability. */
  provider?: string;
  model?: string;

  /** Aspect and length, where the kind supports them. */
  width?: number;
  height?: number;
  durationSec?: number;
  fps?: number;
  seed?: number;

  /** Reference asset ids that constrain appearance. */
  referenceAssetIds?: string[];

  /** Motion timing borrowed from an ingested shot. Never its imagery. */
  motionReference?: {
    shotId: string;
    durationSec: number;
    motionClass: Shot["motionClass"];
    /** What the motion does, in words. Written by an operator or a vision pass. */
    description: string;
  };

  affordances?: PropAffordances;
  tags?: string[];
}

/**
 * Assembles the text prompt for an asset from the character's design anchors plus
 * the specific request. Anchors go first and are repeated for animation, because
 * consistency across a set is the thing that most often breaks.
 */
export function buildPrompt(
  character: Character | undefined,
  request: {
    kind: AssetKind;
    description: string;
    motion?: { description: string; durationSec?: number };
    prop?: { name: string; affordances?: PropAffordances };
    environment?: string;
    styleNotes?: string;
  },
): string {
  const parts: string[] = [];

  if (character) {
    parts.push(character.appearance.brief.trim());
    if (character.appearance.anchors.length > 0) {
      parts.push(`Consistent throughout: ${character.appearance.anchors.join(", ")}.`);
    }
    if (character.appearance.wardrobe?.length && request.kind !== "prop") {
      parts.push(`Wearing: ${character.appearance.wardrobe.join(", ")}.`);
    }
  }

  parts.push(request.description.trim());

  if (request.motion) {
    const timing = request.motion.durationSec
      ? ` over roughly ${request.motion.durationSec.toFixed(1)} seconds`
      : "";
    parts.push(`Motion: ${request.motion.description}${timing}.`);
  }

  if (request.prop) {
    const a = request.prop.affordances;
    const handling = a?.accepts?.length ? ` The ${request.prop.name} can be ${a.accepts.join(", ")}.` : "";
    const material = a?.material ? ` It reads as ${a.material}.` : "";
    const weight =
      a?.weight !== undefined
        ? ` It handles as ${a.weight > 0.66 ? "heavy" : a.weight > 0.33 ? "moderate" : "light"}.`
        : "";
    parts.push(`Prop: ${request.prop.name}.${handling}${material}${weight}`);
  }

  if (request.environment) parts.push(`Setting: ${request.environment}.`);
  if (request.styleNotes) parts.push(request.styleNotes);

  return parts.filter(Boolean).join(" ");
}

/** Capability a kind needs, used to pick a provider when none is named. */
export function capabilityFor(kind: AssetKind) {
  switch (kind) {
    case "animation":
      return "video" as const;
    case "voiceline":
      return "voice" as const;
    case "mesh3d":
      return "mesh3d" as const;
    default:
      return "image" as const;
  }
}

/**
 * Builds an animation spec from an ingested shot. Only timing and motion class
 * cross over — the shot's frames are not attached as visual reference, which is
 * what keeps an ingested performance from becoming a likeness.
 */
export function animationFromShot(
  character: Character,
  shot: Shot,
  description: string,
  overrides: Partial<AssetSpec> = {},
): Omit<AssetSpec, "id"> {
  return {
    kind: "animation",
    characterSlug: character.slug,
    name: `${character.slug}-${shot.motionClass}-${shot.index}`,
    prompt: buildPrompt(character, {
      kind: "animation",
      description,
      motion: { description, durationSec: shot.durationSec },
    }),
    durationSec: shot.durationSec,
    referenceAssetIds: character.appearance.referenceAssetIds ?? [],
    motionReference: {
      shotId: shot.id,
      durationSec: shot.durationSec,
      motionClass: shot.motionClass,
      description,
    },
    tags: ["from-ingest", shot.motionClass],
    ...overrides,
  };
}
