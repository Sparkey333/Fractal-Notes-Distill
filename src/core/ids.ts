import { randomUUID, createHash } from "node:crypto";

/** Opaque unique id, prefixed so stray ids are identifiable in logs. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** URL/filesystem-safe slug derived from a display name. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : `unnamed-${randomUUID().slice(0, 8)}`;
}

/** Stable content hash. Used for asset provenance and dedupe. */
export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
