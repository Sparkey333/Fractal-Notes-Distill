# Architecture

```
  ingest/          characters/        mind/
  video → shots    design docs        memory · heartbeat · dream
        │                │                    │
        │  timing only   │                    │
        └────────────────┼────────────────────┘
                         │
                    assets/          policy/
                    prompt + queue ← likeness gate
                         │
                    providers/
                    BYOK · local · routing
```

Everything is plain files under `.studio/`. No database, no daemon, no build step.
A character is something you can read, diff, copy to another machine, and hand-edit.

## Layers

### `core/`

Paths, atomic JSON/JSONL persistence, ids. Every write goes through
`writeJson`/`appendJsonl` so an interrupted write leaves the previous file intact
rather than a truncated one — which matters most for the keystore and for episodic
memory.

### `providers/`

A catalog of 25 backends (`catalog.ts`), a BYOK keystore with optional encryption
at rest (`keystore.ts`), runtime endpoint overrides and probing (`registry.ts`),
and one `complete()` spanning three wire protocols (`chat.ts`).

The point of the abstraction is that the mind layer never learns whether it is
talking to Ollama on localhost or a hosted endpoint. A character is portable
between machines because its definition names a *model*, and the machine decides
what serves it.

### `characters/`

The design document: persona, appearance anchors, voice, motion vocabulary,
content rating, likeness declaration. Authored data — the mind reads it and never
rewrites it. That separation is what lets a character be retrained (memory wiped or
rolled back) without being redesigned.

`appearance.anchors` deserve a note: short tags repeated into every generation
prompt. Consistency across a large asset set is the thing that most often breaks,
and repeating anchors is the cheapest defence.

### `mind/`

Two tiers, because a character accumulates episodes far faster than any prompt can
hold.

**Episodic** (`memory.jsonl`) is append-only: interactions, observations, actions,
reflections, dreams. Cheap to write, never loaded wholesale.

**Semantic** (`semantic.json`) is the distillate: confidence-weighted beliefs, each
pointing back at the episodes that produced it, plus a slow-moving mood.

Retrieval (`recall`) scores recency, salience and lexical overlap together.
Deliberately unsophisticated — no embedding provider required, so a character stays
fully functional on a laptop running nothing but Ollama.

**Dreaming** (`dream.ts`) is what moves material between tiers. It reads the
unconsolidated backlog, asks the model for at most six standing beliefs and a
first-person narrative, folds those into semantic memory, and stamps the episodes
as processed. Episodes are kept, not deleted: the log is ground truth and beliefs
are a lossy index over it, so a bad consolidation can be discarded and re-derived.

Near-duplicate beliefs corroborate rather than duplicate — Jaccard overlap on
content words, confidence raised toward 1 asymptotically. Without that, repeated
dreams would silently inflate the belief set until it crowded out everything else.

**The heartbeat** (`heartbeat.ts`) is what makes time pass. Each tick: one
unprompted thought, mood decay toward baseline, and consolidation once the backlog
crosses the character's threshold. The scheduler wakes on a fixed resolution and
ticks whoever is due, so one slow character cannot delay the others; first ticks
are staggered randomly so a large roster does not stampede the backend on startup;
a tick already in flight is never stacked on.

A tick failing is an ordinary condition — a local model being unloaded, a rate
limit — so failures are captured into the result rather than thrown, and the
scheduler survives them.

### `ingest/`

`ffmpeg.ts` wraps ffprobe and ffmpeg's scene filter. `manifest.ts` turns the output
into shots with boundaries, mean and peak motion energy, and a coarse motion class
(`static` / `drift` / `gesture` / `sustained` / `violent`).

ffmpeg is an optional dependency: without it the studio still catalogues media and
records what it cannot analyse, rather than refusing to run.

Re-running ingest on a directory is safe — media already analysed at the same path
and size is skipped, so a folder can be re-scanned as footage lands.

What ingest produces is a description of *how things move*, not of *who is in
frame*. See [POLICY.md](POLICY.md) for why that line is where it is.

### `assets/`

`spec.ts` assembles prompts: character brief, then anchors, then wardrobe, then the
specific request, then motion, props and setting. Props carry affordances — the
verbs they accept, their material, how heavy they play — so the character's motion
vocabulary supplies the verb and the prop supplies what the verb applies to.

`queue.ts` is a durable job queue. Generation is slow, rate-limited and frequently
interrupted, so jobs live on disk with their full spec and provenance. A crashed
run resumes; a completed run stays auditable.

`renderRequest()` normalizes a job into a provider payload without executing it.
That separation means a spec can be inspected or diffed, and dispatch can happen
wherever the credentials actually live — including an MCP client, so this process
never needs to hold them.

### `policy/`

Likeness provenance, consent records with age-verification metadata and expiry, and
an append-only audit trail. Checked at character creation, at enqueue, and at
dispatch.

### `server/`

`api.ts` is pure functions of a parsed body — testable without a socket, and shared
with the CLI so both exercise the same paths. `serve.ts` binds loopback only and
requires a token printed at startup, because this server can read and write BYOK
secrets.

## Design decisions worth knowing

**Zero dependencies.** Node 22.18+ strips TypeScript types natively. No build, no
lockfile drift, no supply chain. `npm install` is only needed for `tsc --noEmit`.

**Plain files over a database.** The entire state of a character is three files you
can read. Debugging a misbehaving mind means opening `memory.jsonl`.

**Policy at three checkpoints, not one.** Enqueue-time checking alone means consent
withdrawal only ever applies to work nobody has submitted yet.

**Timing crosses over from footage; identity does not.** This is the one place the
studio is opinionated by design rather than by configuration.

## Extending

- **New provider** — one entry in `src/providers/catalog.ts`. If it speaks an
  existing protocol, that is the whole change.
- **New asset kind** — add to `AssetKind`, map it in `capabilityFor()`, handle it
  in `buildPrompt()`.
- **Better retrieval** — `recall()` is one function. Swap lexical overlap for
  embeddings behind the same signature; every caller is unaffected.
- **Richer affect** — `nudgeMood()` in `mind.ts` is a keyword heuristic and is the
  obvious first thing to replace with a real classifier.
