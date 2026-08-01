import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { paths } from "../core/paths.ts";
import { readJson, writeJson } from "../core/store.ts";
import { requireProvider } from "./catalog.ts";

/**
 * BYOK secret storage.
 *
 * Keys are written to `.studio/keys.json` with mode 0600 and are gitignored. When
 * STUDIO_PASSPHRASE is set, values are additionally encrypted at rest with
 * AES-256-GCM under a scrypt-derived key — worth doing on a laptop that syncs, or
 * any machine where file permissions alone are not a boundary you trust.
 *
 * Resolution order is env var, then keystore. Env wins so CI and headless runs can
 * inject credentials without touching disk.
 */

interface StoredSecret {
  /** Plaintext when unencrypted; base64 ciphertext when `enc` is set. */
  value: string;
  enc?: "aes-256-gcm";
  salt?: string;
  iv?: string;
  tag?: string;
  updatedAt: string;
}

type KeystoreFile = Record<string, StoredSecret>;

function passphrase(): string | undefined {
  const p = process.env.STUDIO_PASSPHRASE;
  return p && p.length > 0 ? p : undefined;
}

function deriveKey(pass: string, salt: Buffer): Buffer {
  return scryptSync(pass, salt, 32, { N: 2 ** 15, r: 8, p: 1 });
}

function seal(plaintext: string): StoredSecret {
  const pass = passphrase();
  const updatedAt = new Date().toISOString();
  if (!pass) return { value: plaintext, updatedAt };

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(pass, salt), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    value: ct.toString("base64"),
    enc: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    updatedAt,
  };
}

function open(secret: StoredSecret): string {
  if (!secret.enc) return secret.value;
  const pass = passphrase();
  if (!pass) {
    throw new Error(
      "This keystore is encrypted. Set STUDIO_PASSPHRASE to unlock it.",
    );
  }
  const salt = Buffer.from(secret.salt!, "base64");
  const iv = Buffer.from(secret.iv!, "base64");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(pass, salt), iv);
  decipher.setAuthTag(Buffer.from(secret.tag!, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(secret.value, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Could not decrypt keystore — wrong STUDIO_PASSPHRASE.");
  }
}

function load(): KeystoreFile {
  return readJson<KeystoreFile>(paths.keystore, {});
}

function save(store: KeystoreFile): void {
  writeJson(paths.keystore, store, { mode: 0o600 });
}

export function setKey(providerId: string, key: string): void {
  requireProvider(providerId);
  const trimmed = key.trim();
  if (trimmed.length === 0) throw new Error("Refusing to store an empty key.");
  const store = load();
  store[providerId] = seal(trimmed);
  save(store);
}

export function deleteKey(providerId: string): boolean {
  const store = load();
  if (!(providerId in store)) return false;
  delete store[providerId];
  save(store);
  return true;
}

export interface ResolvedKey {
  key: string;
  source: "env" | "keystore";
}

export function resolveKey(providerId: string): ResolvedKey | undefined {
  const spec = requireProvider(providerId);
  if (spec.envVar) {
    const fromEnv = process.env[spec.envVar];
    if (fromEnv && fromEnv.length > 0) return { key: fromEnv, source: "env" };
  }
  const stored = load()[providerId];
  if (stored) return { key: open(stored), source: "keystore" };
  return undefined;
}

/** True when a key is available from any source. Never returns the key itself. */
export function hasKey(providerId: string): boolean {
  try {
    return resolveKey(providerId) !== undefined;
  } catch {
    // Encrypted store we cannot open still counts as "a key exists".
    return providerId in load();
  }
}

export function keySource(providerId: string): "env" | "keystore" | "none" {
  const spec = requireProvider(providerId);
  if (spec.envVar && process.env[spec.envVar]) return "env";
  return providerId in load() ? "keystore" : "none";
}

/** Last four characters only. For confirming which key is loaded without exposing it. */
export function maskKey(providerId: string): string | undefined {
  let key: string;
  try {
    const resolved = resolveKey(providerId);
    if (!resolved) return undefined;
    key = resolved.key;
  } catch {
    return "••••(locked)";
  }
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

/** Constant-time compare, for the local server's session token. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
