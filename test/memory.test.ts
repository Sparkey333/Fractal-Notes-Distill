import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "studio-memory-"));
process.env.STUDIO_HOME = sandbox;

const { ensureStudioTree } = await import("../src/core/paths.ts");
const { createCharacter, addMotion, requireCharacter } = await import(
  "../src/characters/store.ts"
);
const {
  remember,
  recall,
  episodes,
  unconsolidated,
  markConsolidated,
  upsertBelief,
  beliefs,
  setMood,
  decayMood,
  semantic,
  workingContext,
} = await import("../src/mind/memory.ts");

const SLUG = "test-subject";

before(() => {
  ensureStudioTree();
  createCharacter({
    name: "Test Subject",
    persona: { summary: "A character used for testing.", traits: ["patient"] },
    appearance: { brief: "Nondescript.", anchors: ["plain"] },
    likeness: { origin: "original-synthetic" },
  });
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

describe("episodic memory", () => {
  test("episodes persist and read back in order", () => {
    remember(SLUG, { kind: "observation", content: "The room went quiet.", salience: 0.4 });
    remember(SLUG, { kind: "action", content: "I waited it out.", salience: 0.3 });
    const log = episodes(SLUG);
    assert.ok(log.length >= 2);
    assert.equal(log.at(-1)!.content, "I waited it out.");
  });

  test("salience is clamped into range", () => {
    const high = remember(SLUG, { kind: "observation", content: "over", salience: 9 });
    const low = remember(SLUG, { kind: "observation", content: "under", salience: -3 });
    assert.equal(high.salience, 1);
    assert.equal(low.salience, 0);
  });

  test("recall ranks a lexical match above unrelated noise", () => {
    remember(SLUG, {
      kind: "interaction",
      content: "Marguerite asked about the piano tuning.",
      salience: 0.5,
    });
    for (let i = 0; i < 5; i++) {
      remember(SLUG, { kind: "observation", content: `unrelated filler ${i}`, salience: 0.5 });
    }
    const hits = recall(SLUG, { query: "piano tuning", limit: 3 });
    assert.ok(
      hits.some((e) => e.content.includes("piano")),
      "the piano episode should surface for a piano query",
    );
  });

  test("recall respects the kind filter", () => {
    const only = recall(SLUG, { kinds: ["action"], limit: 10 });
    assert.ok(only.length > 0);
    assert.ok(only.every((e) => e.kind === "action"));
  });

  test("consolidation stamps episodes without deleting them", () => {
    const before = episodes(SLUG).length;
    const pending = unconsolidated(SLUG);
    assert.ok(pending.length > 0);

    markConsolidated(SLUG, pending.map((e) => e.id));

    assert.equal(episodes(SLUG).length, before, "the log must not lose entries");
    assert.equal(unconsolidated(SLUG).length, 0);
    assert.ok(episodes(SLUG).every((e) => e.kind === "dream" || e.consolidatedAt));
  });
});

describe("semantic memory", () => {
  test("a new belief is stored with its sources", () => {
    const belief = upsertBelief(SLUG, {
      statement: "The lounge empties out before the last set.",
      confidence: 0.5,
      sources: ["ep_one"],
    });
    assert.equal(belief.confidence, 0.5);
    assert.deepEqual(belief.sources, ["ep_one"]);
  });

  test("a near-duplicate corroborates instead of duplicating", () => {
    const countBefore = beliefs(SLUG).length;
    const again = upsertBelief(SLUG, {
      statement: "The lounge empties out before the last set, always.",
      confidence: 0.5,
      sources: ["ep_two"],
    });
    assert.equal(beliefs(SLUG).length, countBefore, "no second copy should be created");
    assert.ok(again.confidence > 0.5, "confidence should rise on corroboration");
    assert.ok(again.sources.includes("ep_one") && again.sources.includes("ep_two"));
  });

  test("a genuinely different statement creates a separate belief", () => {
    const countBefore = beliefs(SLUG).length;
    upsertBelief(SLUG, {
      statement: "Brass instruments go sharp under the stage lights.",
      confidence: 0.6,
      sources: ["ep_three"],
    });
    assert.equal(beliefs(SLUG).length, countBefore + 1);
  });
});

describe("mood", () => {
  test("valence and arousal clamp to their ranges", () => {
    const mood = setMood(SLUG, { valence: 5, arousal: -2 });
    assert.equal(mood.valence, 1);
    assert.equal(mood.arousal, 0);
  });

  test("decay pulls both toward baseline", () => {
    setMood(SLUG, { valence: 1, arousal: 1 });
    const decayed = decayMood(SLUG, 0.5);
    assert.ok(decayed.valence < 1 && decayed.valence > 0);
    assert.ok(decayed.arousal < 1 && decayed.arousal > 0.3);
  });

  test("mood survives a round trip through disk", () => {
    setMood(SLUG, { valence: -0.4, arousal: 0.7 });
    assert.equal(semantic(SLUG).mood.valence, -0.4);
  });
});

describe("working context", () => {
  test("assembles beliefs, mood and recalled episodes into a prompt block", () => {
    const context = workingContext(SLUG, "piano");
    assert.match(context, /hold to be true/);
    assert.match(context, /How you feel right now/);
    assert.ok(context.length > 50);
  });
});

describe("motion vocabulary", () => {
  test("motions are added and merged rather than duplicated", () => {
    addMotion(SLUG, {
      name: "shoulder-roll",
      description: "a slow roll back through one shoulder",
      durationSec: 1.2,
      sourceShotIds: ["shot_a"],
    });
    addMotion(SLUG, {
      name: "Shoulder-Roll",
      description: "a slow roll back through one shoulder",
      sourceShotIds: ["shot_b"],
      assetIds: ["asset_1"],
    });

    const motions = requireCharacter(SLUG).motions;
    const rolls = motions.filter((m) => m.name.toLowerCase() === "shoulder-roll");
    assert.equal(rolls.length, 1, "case-insensitive name match should merge");
    assert.deepEqual(rolls[0]!.sourceShotIds, ["shot_a", "shot_b"]);
    assert.deepEqual(rolls[0]!.assetIds, ["asset_1"]);
    assert.equal(rolls[0]!.durationSec, 1.2, "existing timing should be kept");
  });
});
