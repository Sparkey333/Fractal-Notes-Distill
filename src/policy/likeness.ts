import { join } from "node:path";
import { existsSync } from "node:fs";
import { paths } from "../core/paths.ts";
import { readJson, writeJson, appendJsonl } from "../core/store.ts";
import { newId } from "../core/ids.ts";

/**
 * Likeness provenance and consent records.
 *
 * Any studio that produces adult or otherwise sensitive material needs to answer
 * one question for every character it ships: whose face and body is this, and what
 * permits it. This module makes that answer a required, auditable field rather
 * than tribal knowledge.
 *
 * Two origins are permitted:
 *
 *   original-synthetic  The design came from written description alone, with no
 *                       real individual as reference. Nobody to get consent from.
 *
 *   consented-performer A real, identified adult performer, with a consent record
 *                       on file naming the permitted uses.
 *
 * Deriving a character's likeness from found footage of an identifiable person is
 * rejected — that is exactly the path that produces non-consensual intimate
 * imagery, and it is unlawful in most jurisdictions the moment the output is
 * sexual. Ingested media can still drive *motion*, framing, timing and staging,
 * which is where its real value is anyway; see `ingest/` for that split.
 */

export type LikenessOrigin = "original-synthetic" | "consented-performer";

export interface ConsentRecord {
  id: string;
  /** Performer's legal name, as it appears on the verifying document. */
  performerName: string;
  /** How age was verified. Not the document itself — never store that here. */
  ageVerification: {
    method: "government-id" | "third-party-service" | "notarized-declaration";
    verifiedBy: string;
    verifiedAt: string;
    /** Reference into whatever system of record holds the actual document. */
    documentRef: string;
  };
  /** Uses the performer agreed to, in plain language. */
  permittedUses: string[];
  /** Uses explicitly withheld. Enforced ahead of permittedUses. */
  withheldUses: string[];
  /** ISO date. Generation is refused past this date until renewed. */
  expiresAt?: string;
  /** Set when the performer withdraws consent. Blocks all further use. */
  revokedAt?: string;
  createdAt: string;
}

export interface LikenessDeclaration {
  origin: LikenessOrigin;
  /** Required when origin is consented-performer. */
  consentRecordId?: string;
  /**
   * Free-text description the design was synthesized from. Retained so the design
   * can be regenerated or defended later.
   */
  designNotes?: string;
}

const consentFile = (id: string) => join(paths.consent, `${id}.json`);

export function createConsentRecord(
  input: Omit<ConsentRecord, "id" | "createdAt">,
): ConsentRecord {
  const record: ConsentRecord = {
    ...input,
    id: newId("consent"),
    createdAt: new Date().toISOString(),
  };
  writeJson(consentFile(record.id), record, { mode: 0o600 });
  audit("consent.created", { consentRecordId: record.id });
  return record;
}

export function getConsentRecord(id: string): ConsentRecord | undefined {
  const file = consentFile(id);
  return existsSync(file) ? readJson<ConsentRecord | undefined>(file, undefined) : undefined;
}

export function revokeConsent(id: string): ConsentRecord {
  const record = getConsentRecord(id);
  if (!record) throw new Error(`No consent record ${id}.`);
  const revoked = { ...record, revokedAt: new Date().toISOString() };
  writeJson(consentFile(id), revoked, { mode: 0o600 });
  audit("consent.revoked", { consentRecordId: id });
  return revoked;
}

export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Validates a likeness declaration, optionally against a specific intended use.
 * Called before a character is created and again before each generation job, so a
 * revoked or expired record stops work already in flight.
 */
export function checkLikeness(
  declaration: LikenessDeclaration,
  intendedUse?: string,
): PolicyVerdict {
  if (declaration.origin === "original-synthetic") {
    return { allowed: true };
  }

  if (!declaration.consentRecordId) {
    return {
      allowed: false,
      reason:
        "A consented-performer likeness needs a consent record. " +
        "Create one with `studio consent add`, or use origin=original-synthetic.",
    };
  }

  const record = getConsentRecord(declaration.consentRecordId);
  if (!record) {
    return {
      allowed: false,
      reason: `Consent record ${declaration.consentRecordId} not found.`,
    };
  }
  if (record.revokedAt) {
    return {
      allowed: false,
      reason: `${record.performerName} withdrew consent on ${record.revokedAt.slice(0, 10)}.`,
    };
  }
  if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) {
    return {
      allowed: false,
      reason: `Consent for ${record.performerName} expired ${record.expiresAt.slice(0, 10)}.`,
    };
  }

  if (intendedUse) {
    const withheld = record.withheldUses.find((u) => matches(u, intendedUse));
    if (withheld) {
      return {
        allowed: false,
        reason: `${record.performerName} withheld consent for "${withheld}".`,
      };
    }
    const permitted = record.permittedUses.some((u) => matches(u, intendedUse));
    if (!permitted) {
      return {
        allowed: false,
        reason:
          `"${intendedUse}" is not among the uses ${record.performerName} agreed to ` +
          `(${record.permittedUses.join(", ") || "none recorded"}).`,
      };
    }
  }

  return { allowed: true };
}

function matches(pattern: string, use: string): boolean {
  return use.toLowerCase().includes(pattern.toLowerCase().trim());
}

/** Throwing form, for call sites that should not proceed on a denial. */
export function assertLikeness(
  declaration: LikenessDeclaration,
  intendedUse?: string,
): void {
  const verdict = checkLikeness(declaration, intendedUse);
  if (!verdict.allowed) throw new Error(`Blocked by likeness policy: ${verdict.reason}`);
}

/**
 * Append-only audit trail. Consent decisions are the kind of thing that gets asked
 * about long after the fact, so every check that touches a real performer is
 * recorded with enough context to reconstruct it.
 */
export function audit(event: string, detail: Record<string, unknown>): void {
  appendJsonl(join(paths.logs, "policy-audit.jsonl"), {
    at: new Date().toISOString(),
    event,
    ...detail,
  });
}
