import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// STUDIO_HOME is read at import time, so it must be set before the modules load.
const sandbox = mkdtempSync(join(tmpdir(), "studio-policy-"));
process.env.STUDIO_HOME = sandbox;

const { ensureStudioTree } = await import("../src/core/paths.ts");
const { createConsentRecord, revokeConsent, checkLikeness, assertLikeness } =
  await import("../src/policy/likeness.ts");

before(() => ensureStudioTree());
after(() => rmSync(sandbox, { recursive: true, force: true }));

function validConsent(overrides: Partial<Parameters<typeof createConsentRecord>[0]> = {}) {
  return createConsentRecord({
    performerName: "A. Performer",
    ageVerification: {
      method: "government-id",
      verifiedBy: "Studio Ops",
      verifiedAt: new Date().toISOString(),
      documentRef: "vault://records/1",
    },
    permittedUses: ["reference", "animation"],
    withheldUses: ["voice"],
    ...overrides,
  });
}

describe("likeness policy", () => {
  test("synthetic designs need no consent record", () => {
    const verdict = checkLikeness({ origin: "original-synthetic" });
    assert.equal(verdict.allowed, true);
  });

  test("a performer likeness without a consent record is refused", () => {
    const verdict = checkLikeness({ origin: "consented-performer" });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason!, /needs a consent record/);
  });

  test("a performer likeness naming a missing record is refused", () => {
    const verdict = checkLikeness({
      origin: "consented-performer",
      consentRecordId: "consent_does_not_exist",
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason!, /not found/);
  });

  test("a valid record permits use", () => {
    const record = validConsent();
    const verdict = checkLikeness({
      origin: "consented-performer",
      consentRecordId: record.id,
    });
    assert.equal(verdict.allowed, true);
  });

  test("revocation blocks immediately", () => {
    const record = validConsent();
    const declaration = {
      origin: "consented-performer" as const,
      consentRecordId: record.id,
    };
    assert.equal(checkLikeness(declaration).allowed, true);

    revokeConsent(record.id);

    const after = checkLikeness(declaration);
    assert.equal(after.allowed, false);
    assert.match(after.reason!, /withdrew consent/);
  });

  test("an expired record blocks", () => {
    const record = validConsent({ expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
    const verdict = checkLikeness({
      origin: "consented-performer",
      consentRecordId: record.id,
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason!, /expired/);
  });

  test("withheld uses are refused even when other uses are permitted", () => {
    const record = validConsent();
    const declaration = {
      origin: "consented-performer" as const,
      consentRecordId: record.id,
    };
    assert.equal(checkLikeness(declaration, "animation:general").allowed, true);
    const withheld = checkLikeness(declaration, "voiceline:voice");
    assert.equal(withheld.allowed, false);
    assert.match(withheld.reason!, /withheld consent/);
  });

  test("a use outside the permitted list is refused", () => {
    const record = validConsent();
    const verdict = checkLikeness(
      { origin: "consented-performer", consentRecordId: record.id },
      "mesh3d:adult",
    );
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason!, /not among the uses/);
  });

  test("assertLikeness throws on a denial", () => {
    assert.throws(
      () => assertLikeness({ origin: "consented-performer" }),
      /Blocked by likeness policy/,
    );
  });
});
