import { join } from "node:path";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { characterDir, paths } from "../core/paths.ts";
import { readJson, writeJson } from "../core/store.ts";
import { newId, slugify } from "../core/ids.ts";
import { assertLikeness, audit } from "../policy/likeness.ts";
import {
  DEFAULT_MIND,
  validateDraft,
  type Character,
  type CharacterDraft,
  type MotionEntry,
} from "./schema.ts";

/**
 * Characters are stored one directory per character, keyed by slug:
 *
 *   .studio/characters/<slug>/character.json   design document
 *                             /memory.jsonl    episodic log (mind/memory.ts)
 *                             /semantic.json   consolidated beliefs
 *
 * Plain files on purpose — a character is a thing an operator should be able to
 * read, diff, copy between machines, and hand-edit.
 */

const defFile = (slug: string) => join(characterDir(slug), "character.json");

export function createCharacter(draft: CharacterDraft): Character {
  const errors = validateDraft(draft);
  if (errors.length > 0) {
    throw new Error(`Invalid character draft:\n  - ${errors.join("\n  - ")}`);
  }

  // Gate at creation as well as at generation: a character that could never
  // lawfully be rendered should not exist in the roster at all.
  assertLikeness(draft.likeness);

  const slug = slugify(draft.name);
  if (existsSync(defFile(slug))) {
    throw new Error(`Character "${slug}" already exists. Pick another name.`);
  }

  const now = new Date().toISOString();
  const character: Character = {
    id: newId("char"),
    slug,
    name: draft.name.trim(),
    tagline: draft.tagline,
    persona: draft.persona,
    appearance: draft.appearance,
    likeness: draft.likeness,
    voice: draft.voice,
    mind: { ...DEFAULT_MIND, ...draft.mind },
    motions: [],
    contentRating: draft.contentRating ?? "general",
    tags: draft.tags ?? [],
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };

  writeJson(defFile(slug), character);
  audit("character.created", {
    characterId: character.id,
    slug,
    likenessOrigin: character.likeness.origin,
    consentRecordId: character.likeness.consentRecordId,
    contentRating: character.contentRating,
  });
  return character;
}

export function getCharacter(slug: string): Character | undefined {
  const file = defFile(slug);
  return existsSync(file) ? readJson<Character | undefined>(file, undefined) : undefined;
}

export function requireCharacter(slug: string): Character {
  const character = getCharacter(slug);
  if (!character) {
    const known = listCharacters().map((c) => c.slug);
    throw new Error(
      `No character "${slug}".` +
        (known.length ? ` Known: ${known.join(", ")}` : " The roster is empty."),
    );
  }
  return character;
}

export function listCharacters(): Character[] {
  if (!existsSync(paths.characters)) return [];
  return readdirSync(paths.characters, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => getCharacter(e.name))
    .filter((c): c is Character => c !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function saveCharacter(character: Character): Character {
  const next: Character = {
    ...character,
    updatedAt: new Date().toISOString(),
    revision: character.revision + 1,
  };
  writeJson(defFile(next.slug), next);
  return next;
}

export function updateCharacter(
  slug: string,
  mutate: (current: Character) => Character,
): Character {
  return saveCharacter(mutate(requireCharacter(slug)));
}

export function deleteCharacter(slug: string): boolean {
  const dir = characterDir(slug);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  audit("character.deleted", { slug });
  return true;
}

/**
 * Adds a motion to a character's vocabulary, or merges into the existing entry of
 * the same name. Motions accumulate from ingest and from generated animation, so
 * merging rather than duplicating keeps the vocabulary clean.
 */
export function addMotion(
  slug: string,
  motion: Omit<MotionEntry, "id"> & { id?: string },
): Character {
  return updateCharacter(slug, (character) => {
    const existing = character.motions.find(
      (m) => m.name.toLowerCase() === motion.name.toLowerCase(),
    );
    if (!existing) {
      return {
        ...character,
        motions: [...character.motions, { ...motion, id: motion.id ?? newId("motion") }],
      };
    }
    const merged: MotionEntry = {
      ...existing,
      description: motion.description || existing.description,
      durationSec: motion.durationSec ?? existing.durationSec,
      sourceShotIds: unique([
        ...(existing.sourceShotIds ?? []),
        ...(motion.sourceShotIds ?? []),
      ]),
      assetIds: unique([...(existing.assetIds ?? []), ...(motion.assetIds ?? [])]),
      tags: unique([...(existing.tags ?? []), ...(motion.tags ?? [])]),
    };
    return {
      ...character,
      motions: character.motions.map((m) => (m.id === existing.id ? merged : m)),
    };
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
