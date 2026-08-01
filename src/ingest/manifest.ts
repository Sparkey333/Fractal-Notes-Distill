import { join, basename, extname } from "node:path";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { paths } from "../core/paths.ts";
import { readJson, writeJson } from "../core/store.ts";
import { newId, slugify } from "../core/ids.ts";
import {
  detectSceneChanges,
  extractFrames,
  ffmpegAvailable,
  motionProfile,
  probeMedia,
  type MediaInfo,
} from "./ffmpeg.ts";

/**
 * Ingest turns source footage into a structured description of *how things move*:
 * where the cuts fall, how long each shot runs, how much motion each carries, and
 * what the framing is doing. That description is what drives animation work.
 *
 * What ingest deliberately does not produce is a likeness. Faces and bodies in
 * source footage belong to people who did not agree to appear in anything this
 * studio makes, so every source is admitted with `likenessUse: "denied"` and the
 * asset layer refuses to accept a source frame as a character reference. Timing,
 * staging and motion carry across; identity does not.
 *
 * If you hold a signed release for a performer in the footage, record it with
 * `studio consent add` and set the source's likenessUse to that record — the gate
 * is a consent check, not a blanket ban.
 */

export const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".mpg", ".mpeg", ".wmv", ".flv",
]);

export type LikenessUse =
  | "denied"
  /** Permitted, backed by the named consent record. */
  | `consent:${string}`;

export interface Shot {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  /** Mean scene-difference across the shot, 0–1. High means busy. */
  motionEnergy: number;
  /** Peak difference within the shot. Separates a single burst from steady motion. */
  peakEnergy: number;
  /** Coarse label derived from energy and duration. */
  motionClass: MotionClass;
  keyframeFile?: string;
  /** Operator or model-supplied description of what the motion is. */
  note?: string;
}

export type MotionClass =
  | "static" // locked-off, little change
  | "drift" // slow continuous movement
  | "gesture" // short, contained burst
  | "sustained" // long stretch of steady movement
  | "violent"; // rapid, high-amplitude change

export interface SourceMedia {
  id: string;
  /** Slug derived from the filename; stable handle for CLI use. */
  key: string;
  /** Absolute path as ingested. Media is referenced in place, never copied. */
  file: string;
  filename: string;
  sizeBytes: number;
  info?: MediaInfo;
  shots: Shot[];
  /** Set at ingest; gates whether frames may be used as visual reference. */
  likenessUse: LikenessUse;
  ingestedAt: string;
  /** Populated when analysis could not run. */
  analysisError?: string;
}

export interface ProjectManifest {
  id: string;
  name: string;
  slug: string;
  /** Directory the media was ingested from. */
  sourceDir?: string;
  media: SourceMedia[];
  createdAt: string;
  updatedAt: string;
}

const projectFile = (slug: string) => join(paths.ingest, `${slug}.json`);

export function listProjects(): ProjectManifest[] {
  if (!existsSync(paths.ingest)) return [];
  return readdirSync(paths.ingest)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<ProjectManifest | undefined>(join(paths.ingest, f), undefined))
    .filter((p): p is ProjectManifest => p !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getProject(slug: string): ProjectManifest | undefined {
  const file = projectFile(slug);
  return existsSync(file)
    ? readJson<ProjectManifest | undefined>(file, undefined)
    : undefined;
}

export function requireProject(slug: string): ProjectManifest {
  const project = getProject(slug);
  if (!project) {
    const known = listProjects().map((p) => p.slug);
    throw new Error(
      `No project "${slug}".` + (known.length ? ` Known: ${known.join(", ")}` : ""),
    );
  }
  return project;
}

export function saveProject(project: ProjectManifest): ProjectManifest {
  const next = { ...project, updatedAt: new Date().toISOString() };
  writeJson(projectFile(next.slug), next);
  return next;
}

export function findVideoFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    throw new Error(`No such directory: ${dir}`);
  }
  if (!statSync(dir).isDirectory()) {
    return VIDEO_EXTENSIONS.has(extname(dir).toLowerCase()) ? [dir] : [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .filter((e) => VIDEO_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map((e) => join(dir, e.name))
    .sort();
}

export interface IngestOptions {
  /** Scene-detection sensitivity, 0–1. Lower finds more cuts. */
  threshold?: number;
  /** Write one keyframe per detected shot. */
  keyframes?: boolean;
  /** Progress callback, for CLI output. */
  onProgress?: (message: string) => void;
}

/**
 * Ingests every video in `dir` into a project. Re-running is safe: media already
 * present (same path and size) is left alone, so a directory can be re-scanned as
 * new footage lands.
 */
export async function ingestDirectory(
  name: string,
  dir: string,
  opts: IngestOptions = {},
): Promise<ProjectManifest> {
  const slug = slugify(name);
  const now = new Date().toISOString();
  const existing = getProject(slug);

  const project: ProjectManifest = existing ?? {
    id: newId("proj"),
    name,
    slug,
    sourceDir: dir,
    media: [],
    createdAt: now,
    updatedAt: now,
  };
  project.sourceDir = dir;

  const files = findVideoFiles(dir);
  if (files.length === 0) {
    opts.onProgress?.(`No video files found in ${dir}`);
    return saveProject(project);
  }

  const tools = await ffmpegAvailable();
  if (!tools.ffprobe) {
    opts.onProgress?.(
      `ffmpeg not found — cataloguing files without analysis. ${tools.hint ?? ""}`,
    );
  }

  for (const file of files) {
    const size = statSync(file).size;
    const already = project.media.find((m) => m.file === file && m.sizeBytes === size);
    if (already && already.shots.length > 0) {
      opts.onProgress?.(`skip ${basename(file)} (already analysed)`);
      continue;
    }

    opts.onProgress?.(`analysing ${basename(file)}`);
    const media = await ingestFile(file, slug, tools.ffprobe && tools.ffmpeg, opts);
    project.media = [...project.media.filter((m) => m.file !== file), media];
  }

  return saveProject(project);
}

async function ingestFile(
  file: string,
  projectSlug: string,
  analyse: boolean,
  opts: IngestOptions,
): Promise<SourceMedia> {
  const filename = basename(file);
  const media: SourceMedia = {
    id: newId("media"),
    key: slugify(filename.replace(extname(filename), "")),
    file,
    filename,
    sizeBytes: statSync(file).size,
    shots: [],
    // Admitted without likeness rights by default. Raising this requires a
    // consent record; see policy/likeness.ts.
    likenessUse: "denied",
    ingestedAt: new Date().toISOString(),
  };

  if (!analyse) {
    media.analysisError = "ffmpeg unavailable";
    return media;
  }

  try {
    media.info = await probeMedia(file);
    const cuts = await detectSceneChanges(file, opts.threshold ?? 0.3);
    const profile = await motionProfile(file);
    media.shots = buildShots(cuts, media.info.durationSec, profile);

    if (opts.keyframes !== false && media.shots.length > 0) {
      const frameDir = join(paths.ingest, projectSlug, media.key);
      mkdirSync(frameDir, { recursive: true });
      // Sample a third of the way in — past the cut, before the shot resolves.
      const times = media.shots.map((s) => s.startSec + s.durationSec / 3);
      const written = await extractFrames(file, times, frameDir, "shot");
      media.shots = media.shots.map((shot, i) => ({
        ...shot,
        keyframeFile: written[i],
      }));
    }
  } catch (err) {
    media.analysisError = err instanceof Error ? err.message : String(err);
  }

  return media;
}

/** Turns cut points plus a motion profile into shots with motion classes. */
export function buildShots(
  cuts: number[],
  durationSec: number,
  profile: { t: number; energy: number }[],
): Shot[] {
  const boundaries = [0, ...cuts.filter((t) => t > 0 && t < durationSec), durationSec];
  const shots: Shot[] = [];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const startSec = boundaries[i]!;
    const endSec = boundaries[i + 1]!;
    const durationOfShot = endSec - startSec;
    if (durationOfShot <= 0.04) continue; // sub-frame artefacts from the detector

    const within = profile.filter((s) => s.t >= startSec && s.t < endSec);
    const energies = within.map((s) => s.energy);
    const motionEnergy =
      energies.length > 0 ? energies.reduce((a, b) => a + b, 0) / energies.length : 0;
    const peakEnergy = energies.length > 0 ? Math.max(...energies) : 0;

    shots.push({
      id: newId("shot"),
      index: shots.length,
      startSec: round(startSec),
      endSec: round(endSec),
      durationSec: round(durationOfShot),
      motionEnergy: round(motionEnergy, 4),
      peakEnergy: round(peakEnergy, 4),
      motionClass: classifyMotion(motionEnergy, peakEnergy, durationOfShot),
    });
  }
  return shots;
}

/**
 * Coarse motion taxonomy. The thresholds are tuned for the scene filter's score
 * distribution on edited footage; they are a starting point an operator is
 * expected to adjust per project rather than a universal truth.
 */
export function classifyMotion(
  meanEnergy: number,
  peakEnergy: number,
  durationSec: number,
): MotionClass {
  if (meanEnergy < 0.008) return "static";
  if (peakEnergy > 0.25) return "violent";
  if (meanEnergy < 0.03) return "drift";
  return durationSec < 1.5 ? "gesture" : "sustained";
}

function round(n: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

/** Shots grouped by motion class — the view used when building a motion set. */
export function motionSummary(project: ProjectManifest): Record<MotionClass, Shot[]> {
  const summary: Record<MotionClass, Shot[]> = {
    static: [], drift: [], gesture: [], sustained: [], violent: [],
  };
  for (const media of project.media) {
    for (const shot of media.shots) summary[shot.motionClass].push(shot);
  }
  return summary;
}
