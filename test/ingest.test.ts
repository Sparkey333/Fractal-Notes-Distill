import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STUDIO_HOME = mkdtempSync(join(tmpdir(), "studio-ingest-"));

const { buildShots, classifyMotion, VIDEO_EXTENSIONS } = await import(
  "../src/ingest/manifest.ts"
);

describe("shot segmentation", () => {
  test("cuts become shots spanning the full duration", () => {
    const shots = buildShots([2, 5], 10, []);
    assert.equal(shots.length, 3);
    assert.deepEqual(
      shots.map((s) => [s.startSec, s.endSec]),
      [
        [0, 2],
        [2, 5],
        [5, 10],
      ],
    );
    assert.equal(shots.at(-1)!.endSec, 10);
  });

  test("no cuts yields one shot for the whole clip", () => {
    const shots = buildShots([], 8.5, []);
    assert.equal(shots.length, 1);
    assert.equal(shots[0]!.durationSec, 8.5);
  });

  test("cuts outside the duration are ignored", () => {
    const shots = buildShots([-1, 3, 99], 6, []);
    assert.deepEqual(
      shots.map((s) => [s.startSec, s.endSec]),
      [
        [0, 3],
        [3, 6],
      ],
    );
  });

  test("sub-frame segments are dropped rather than emitted as shots", () => {
    // A detector firing twice on the same cut produces a ~0 length span.
    const shots = buildShots([4, 4.01], 10, []);
    assert.ok(
      shots.every((s) => s.durationSec > 0.04),
      "no zero-length shots should survive",
    );
  });

  test("shot indices are contiguous after drops", () => {
    const shots = buildShots([2, 2.005, 5], 9, []);
    assert.deepEqual(
      shots.map((s) => s.index),
      shots.map((_, i) => i),
    );
  });

  test("motion energy is averaged within each shot's window only", () => {
    const profile = [
      { t: 0.5, energy: 0.1 },
      { t: 1.5, energy: 0.3 },
      { t: 3.0, energy: 0.9 },
    ];
    const shots = buildShots([2], 4, profile);
    assert.equal(shots.length, 2);
    assert.ok(Math.abs(shots[0]!.motionEnergy - 0.2) < 1e-6, "first shot averages 0.1 and 0.3");
    assert.equal(shots[0]!.peakEnergy, 0.3);
    assert.equal(shots[1]!.motionEnergy, 0.9);
  });

  test("a shot with no samples reports zero rather than NaN", () => {
    const shots = buildShots([], 5, []);
    assert.equal(shots[0]!.motionEnergy, 0);
    assert.equal(shots[0]!.peakEnergy, 0);
    assert.ok(Number.isFinite(shots[0]!.motionEnergy));
  });
});

describe("motion classification", () => {
  test("near-zero change is static", () => {
    assert.equal(classifyMotion(0.001, 0.002, 5), "static");
  });

  test("a high peak reads as violent regardless of mean", () => {
    assert.equal(classifyMotion(0.05, 0.4, 3), "violent");
  });

  test("low steady change is drift", () => {
    assert.equal(classifyMotion(0.02, 0.05, 6), "drift");
  });

  test("a short burst is a gesture, the same energy sustained is not", () => {
    assert.equal(classifyMotion(0.08, 0.15, 1.0), "gesture");
    assert.equal(classifyMotion(0.08, 0.15, 4.0), "sustained");
  });
});

describe("video extensions", () => {
  test("covers the common container formats", () => {
    for (const ext of [".mp4", ".mov", ".mkv", ".webm"]) {
      assert.ok(VIDEO_EXTENSIONS.has(ext), `${ext} should be recognised`);
    }
    assert.ok(!VIDEO_EXTENSIONS.has(".txt"));
  });
});
