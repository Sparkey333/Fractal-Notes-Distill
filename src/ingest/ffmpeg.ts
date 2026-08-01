import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Thin ffmpeg/ffprobe wrappers. ffmpeg is an optional dependency: without it the
 * studio still ingests and tracks media, it just cannot derive shots or
 * keyframes. Callers check `ffmpegAvailable()` and degrade rather than crash.
 */

export interface ToolAvailability {
  ffmpeg: boolean;
  ffprobe: boolean;
  hint?: string;
}

let cached: ToolAvailability | undefined;

export async function ffmpegAvailable(): Promise<ToolAvailability> {
  if (cached) return cached;
  const [ffmpeg, ffprobe] = await Promise.all([
    which("ffmpeg"),
    which("ffprobe"),
  ]);
  cached = {
    ffmpeg,
    ffprobe,
    hint:
      ffmpeg && ffprobe
        ? undefined
        : "Install ffmpeg to enable shot detection and keyframes " +
          "(macOS: `brew install ffmpeg`).",
  };
  return cached;
}

async function which(bin: string): Promise<boolean> {
  try {
    await exec(bin, ["-version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec?: string;
  bitrate?: number;
  hasAudio: boolean;
}

export async function probeMedia(file: string): Promise<MediaInfo> {
  const { stdout } = await exec(
    "ffprobe",
    [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      file,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; bit_rate?: string };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      duration?: string;
    }[];
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error(`No video stream in ${file}`);

  return {
    durationSec: Number(parsed.format?.duration ?? video.duration ?? 0),
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFrameRate(video.avg_frame_rate),
    codec: video.codec_name,
    bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : undefined,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

function parseFrameRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return 0;
  return Number((num / den).toFixed(3));
}

/**
 * Scene-change timestamps, via ffmpeg's scene detector. `threshold` is the
 * fraction of the frame that must change; 0.3 is a reasonable default for edited
 * footage, lower it for long static takes.
 */
export async function detectSceneChanges(
  file: string,
  threshold = 0.3,
): Promise<number[]> {
  // showinfo prints one line per frame that passes the scene filter; we read the
  // pts_time off each. Output goes to stderr, which is where ffmpeg logs.
  const { stderr } = await exec(
    "ffmpeg",
    [
      "-i", file,
      "-filter:v", `select='gt(scene,${threshold})',showinfo`,
      "-f", "null",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
  ).catch((err: { stderr?: string }) => ({ stderr: err.stderr ?? "" }));

  const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)]
    .map((m) => Number(m[1]))
    .filter((t) => Number.isFinite(t));

  return [...new Set(times)].sort((a, b) => a - b);
}

/** Writes one JPEG per timestamp. Returns the files actually produced. */
export async function extractFrames(
  file: string,
  timestamps: number[],
  outDir: string,
  prefix = "frame",
): Promise<string[]> {
  const written: string[] = [];
  for (const [i, t] of timestamps.entries()) {
    const out = `${outDir}/${prefix}-${String(i).padStart(4, "0")}.jpg`;
    try {
      await exec(
        "ffmpeg",
        [
          "-ss", String(t),
          "-i", file,
          "-frames:v", "1",
          "-q:v", "3",
          "-y",
          out,
        ],
        { timeout: 60_000 },
      );
      written.push(out);
    } catch {
      // A seek past the end of a slightly-misreported duration is common and
      // harmless; skip that frame rather than failing the whole ingest.
    }
  }
  return written;
}

/**
 * Per-second motion magnitude, derived from the scene filter's own difference
 * score. This is what drives motion tagging — it needs no model and no likeness
 * information, only how much the frame is changing over time.
 */
export async function motionProfile(file: string): Promise<{ t: number; energy: number }[]> {
  const { stderr } = await exec(
    "ffmpeg",
    [
      "-i", file,
      "-filter:v", "select='gte(scene,0)',metadata=print:file=-",
      "-f", "null",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
  ).catch((err: { stderr?: string; stdout?: string }) => ({
    stderr: `${err.stdout ?? ""}${err.stderr ?? ""}`,
  }));

  const samples: { t: number; energy: number }[] = [];
  const frameRe = /pts_time:([0-9.]+)[\s\S]*?lavfi\.scene_score=([0-9.]+)/g;
  for (const match of stderr.matchAll(frameRe)) {
    const t = Number(match[1]);
    const energy = Number(match[2]);
    if (Number.isFinite(t) && Number.isFinite(energy)) samples.push({ t, energy });
  }
  return samples;
}
