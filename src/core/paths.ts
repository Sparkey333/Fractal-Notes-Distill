import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * All mutable studio state lives under a single root so it can be backed up,
 * inspected, or wiped as a unit. Defaults to `.studio/` beside the repo; override
 * with STUDIO_HOME to keep secrets and media off a synced volume.
 */
export const STUDIO_HOME = resolve(
  process.env.STUDIO_HOME ?? join(process.cwd(), ".studio"),
);

export const paths = {
  root: STUDIO_HOME,
  /** BYOK secrets, 0600. */
  keystore: join(STUDIO_HOME, "keys.json"),
  /** Provider endpoint overrides and studio preferences. */
  config: join(STUDIO_HOME, "config.json"),
  /** One directory per character: definition, memory, dreams. */
  characters: join(STUDIO_HOME, "characters"),
  /** Ingested source media manifests and derivatives (keyframes, shot lists). */
  ingest: join(STUDIO_HOME, "ingest"),
  /** Generated asset outputs plus their provenance records. */
  assets: join(STUDIO_HOME, "assets"),
  /** Durable job queue for generation work. */
  jobs: join(STUDIO_HOME, "jobs"),
  /** Consent and likeness-provenance records. Legally significant; keep. */
  consent: join(STUDIO_HOME, "consent"),
  logs: join(STUDIO_HOME, "logs"),
} as const;

export function characterDir(id: string): string {
  return join(paths.characters, id);
}

/** Creates the full studio tree. Idempotent. */
export function ensureStudioTree(): void {
  for (const dir of [
    paths.root,
    paths.characters,
    paths.ingest,
    paths.assets,
    paths.jobs,
    paths.consent,
    paths.logs,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Expands `~` and resolves against cwd, so CLI path args behave like shell paths. */
export function expandUserPath(input: string): string {
  const expanded = input.startsWith("~/")
    ? join(homedir(), input.slice(2))
    : input === "~"
      ? homedir()
      : input;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}
