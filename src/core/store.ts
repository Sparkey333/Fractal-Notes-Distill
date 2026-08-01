import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Small JSON persistence helpers. Everything the studio writes goes through here
 * so writes are atomic — a crash mid-write leaves the previous file intact rather
 * than a truncated one, which matters for the keystore and character memory.
 */

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    throw new Error(
      `Corrupt JSON at ${file}: ${(err as Error).message}. ` +
        `Move it aside to continue with a fresh file.`,
    );
  }
}

export interface WriteOptions {
  /** File mode for the final file. Use 0o600 for anything holding secrets. */
  mode?: number;
}

export function writeJson(file: string, value: unknown, opts: WriteOptions = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
    mode: opts.mode ?? 0o644,
  });
  renameSync(tmp, file);
  if (opts.mode !== undefined) chmodSync(file, opts.mode);
}

/** Read-modify-write in one call. Returns the value that was written. */
export function updateJson<T>(
  file: string,
  fallback: T,
  mutate: (current: T) => T,
  opts: WriteOptions = {},
): T {
  const next = mutate(readJson(file, fallback));
  writeJson(file, next, opts);
  return next;
}

/** Append one JSON object per line. Used for event logs that only grow. */
export function appendJsonl(file: string, record: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record) + "\n", { flag: "a" });
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`Malformed JSONL at ${file}:${i + 1}`);
      }
    });
}
