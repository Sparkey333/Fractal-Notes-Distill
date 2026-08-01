# studio

A character studio: original AI characters with persistent minds, a model-routing
layer that works with local models or any BYOK cloud provider, video ingest that
turns footage into a motion vocabulary, and a generation queue that carries
provenance with every asset.

Zero dependencies and zero build. Node 22.18+ runs the TypeScript directly.

```bash
node src/cli.ts init
node src/cli.ts doctor
```

## Quickstart

```bash
# 1. Point at a model. Local needs no key:
node src/cli.ts provider probe ollama
node src/cli.ts provider use text ollama

#    …or bring your own key for anything in the catalog:
node src/cli.ts provider set-key anthropic sk-ant-...
node src/cli.ts provider use text anthropic

# 2. Make a character
node src/cli.ts character new --file examples/character.example.json
node src/cli.ts character say vesper-kline "how long have you worked here?"

# 3. Let time pass — idle thoughts, mood drift, and dreaming
node src/cli.ts heartbeat

# 4. Ingest footage into a motion vocabulary
node src/cli.ts ingest "night-one" ~/Videos/night-one
node src/cli.ts project show night-one
node src/cli.ts project motions night-one --character vesper-kline

# 5. Queue asset generation
node src/cli.ts asset new --character vesper-kline --kind animation \
  --description "turns from the mic stand to face the room" \
  --motion "slow pivot on the ball of one foot, chin leading" --duration 2.4

# 6. Or drive it all from the local console
node src/server/serve.ts
```

`node src/cli.ts help` lists every command.

## What's here

| Area | Path | What it does |
|---|---|---|
| Providers | `src/providers/` | 25-provider catalog, BYOK keystore, endpoint probing, one `complete()` across Ollama / OpenAI-compatible / Anthropic wire protocols |
| Characters | `src/characters/` | Design documents: persona, appearance anchors, voice, motion vocabulary |
| Mind | `src/mind/` | Episodic + semantic memory, retrieval, mood, heartbeat scheduler, dream consolidation |
| Ingest | `src/ingest/` | ffmpeg-backed shot detection, motion profiling, keyframes, motion classification |
| Assets | `src/assets/` | Prompt assembly from character anchors, durable job queue, provider request rendering |
| Policy | `src/policy/` | Likeness provenance, consent records, audit trail |
| Console | `src/server/` | Loopback web UI — BYOK tab, character chat, ingest and queue views |

## Providers

Local models need no key, only a reachable endpoint: **Ollama**, **LM Studio**,
**llama.cpp**, **vLLM**, **Jan**, **KoboldCpp**, **Text Generation WebUI**,
**ComfyUI**.

Cloud providers are bring-your-own-key, and every one ships with the URL that
issues keys — `provider list` prints them, and the BYOK tab links them directly.
Includes **Higgsfield**, Anthropic, OpenAI, Google AI Studio, OpenRouter, Groq,
Together, Fireworks, Mistral, DeepSeek, xAI, Cerebras, ElevenLabs, Replicate,
fal.ai, Stability and Hugging Face.

See [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Minds

A character is not a prompt. It keeps an append-only episodic log of what happened
to it, distils that into confidence-weighted beliefs while it dreams, and carries a
mood that drifts between conversations. Two characters with identical definitions
but different histories diverge, and the divergence lives in memory rather than in
the definition — so a character can be retrained without being redesigned.

The heartbeat is what makes time pass: each tick the character has one unprompted
thought, its mood relaxes toward baseline, and once the backlog crosses a threshold
it consolidates. Ticks are one short completion each, so a full roster can idle on
a local model indefinitely.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Likeness and consent

Every character declares where its appearance came from, and that declaration is
enforced rather than documented:

- **`original-synthetic`** — designed from written description alone. No consent
  needed, because there is nobody to get it from.
- **`consented-performer`** — a real adult performer with a consent record on file
  naming the permitted uses, how age was verified, and when it expires.

Consent is checked when a character is created, when a job is queued, and again
when a job is dispatched. That last check is the one that matters: a job can sit in
a queue for days, and consent withdrawn in the interim has to stop work that was
already approved.

Deriving a character's likeness from footage of an identifiable person is not
supported. Ingested media is admitted with `likenessUse: denied`, and only timing,
shot structure and motion energy cross over into the character layer — which is
where the value of reference footage actually is. If you hold a release for someone
in the footage, record it with `consent add` and the gate opens for them
specifically.

See [docs/POLICY.md](docs/POLICY.md).

## Storage

Everything mutable lives under `.studio/` (override with `STUDIO_HOME`), which is
gitignored:

```
.studio/
  keys.json          BYOK secrets, mode 0600
  config.json        endpoint overrides, default provider per capability
  characters/<slug>/ character.json · memory.jsonl · semantic.json
  ingest/            project manifests and extracted keyframes
  jobs/              asset queue
  consent/           consent records, mode 0600
  logs/              policy audit trail
```

Set `STUDIO_PASSPHRASE` to additionally encrypt stored keys at rest with
AES-256-GCM under a scrypt-derived key.

## Tests

```bash
node --test test/*.test.ts
npx tsc --noEmit
```

## Optional tooling

`ffmpeg` and `ffprobe` enable shot detection, motion profiling and keyframes.
Without them the studio still catalogues media, it just cannot analyse it
(`brew install ffmpeg`).
