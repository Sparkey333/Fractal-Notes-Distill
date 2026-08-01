# Likeness and consent

Any studio producing adult or otherwise sensitive material has to answer one
question for every character it ships: **whose face and body is this, and what
permits it.** This is the machinery that makes that answer a required, auditable
field rather than tribal knowledge.

## Two permitted origins

Every character declares one:

### `original-synthetic`

The design came from written description alone, with no real individual as
reference. No consent needed, because there is nobody to get it from.

```json
"likeness": {
  "origin": "original-synthetic",
  "designNotes": "Designed from written description alone. No real individual was used as visual reference at any stage."
}
```

Keep `designNotes` complete enough to regenerate the design from scratch. It is
what you point at if the provenance of a character is ever questioned.

### `consented-performer`

A real, identified adult performer with a consent record on file.

```bash
node src/cli.ts consent add \
  --name "Legal Name" \
  --permitted "reference,animation,expression" \
  --withheld "voiceline" \
  --method government-id \
  --verified-by "Studio Ops" \
  --document-ref "vault://records/performer-001" \
  --expires 2027-01-01
```

Then reference the returned id:

```json
"likeness": {
  "origin": "consented-performer",
  "consentRecordId": "consent_..."
}
```

**Do not store identity documents in this repository.** `documentRef` is a pointer
into whatever system of record actually holds them. Consent records live in
`.studio/consent/` at mode 0600 and are gitignored, but they are designed to hold
*metadata about* verification, not the evidence itself.

## Where the gates are

| Checkpoint | What it catches |
|---|---|
| Character creation | A character that could never lawfully be rendered never enters the roster |
| Job enqueue | A blocked job appears in the queue as a refusal with a reason, not an opaque failure later |
| Job dispatch | Consent withdrawn or expired *after* a job was approved |

The third is the one that matters most. A job can sit queued for days. If
revocation only applied to new jobs, a withdrawal would never reach work already
in flight — which is the opposite of what withdrawing consent means.

```bash
node src/cli.ts consent revoke consent_...
# every queued and future job under that record now fails with the reason
```

Expiry works the same way. A record past `expiresAt` blocks until renewed.

`withheldUses` is checked before `permittedUses`, so withholding one use does not
require re-enumerating everything else.

## What is not supported

**Deriving a character's likeness from footage of an identifiable person.**

Ingested media is admitted with `likenessUse: "denied"`, and the asset layer will
not accept a source frame as a character reference. This is not a configuration
default to be flipped — it is the one place the studio is opinionated by design.

The reason is narrow and practical: that path is how non-consensual intimate
imagery gets made. The moment the output is sexual, it is unlawful in most
jurisdictions this would run in, and the person in the source footage is the one
harmed. No amount of downstream care fixes an input nobody agreed to.

If you hold a release for someone in the footage, record it and the gate opens for
them specifically:

```bash
node src/cli.ts consent add --name "..." --permitted "..." ...
# then set that media's likenessUse to consent:<id>
```

## What does cross over from footage

Almost everything that makes reference footage useful:

- **Shot boundaries** — where the cuts fall, how long each shot runs
- **Motion energy** — mean and peak change per shot
- **Motion class** — static, drift, gesture, sustained, violent
- **Timing** — durations that make generated motion read as real rather than
  metronomic

```bash
node src/cli.ts project motions night-one --character vesper-kline
```

That imports timing and motion class into the character's vocabulary. It carries no
imagery. A character built this way moves with the rhythm of the reference and
looks like nobody but itself — which, for building a consistent cast, is what you
want anyway. A likeness lifted from footage is a liability; a motion vocabulary
lifted from footage is craft.

## Audit trail

Every consent decision, character creation, enqueue and dispatch block is appended
to `.studio/logs/policy-audit.jsonl`:

```json
{"at":"2026-08-01T14:22:31.004Z","event":"asset.blocked_at_dispatch","jobId":"job_...","reason":"… withdrew consent on 2026-08-01"}
```

Append-only, one JSON object per line. These are the questions that get asked long
after the render itself is forgotten.

## Scope of this document

This describes what the software enforces. It is not legal advice, and the gates
here are a floor rather than a compliance program — age verification, record
keeping, platform terms, tax treatment of proceeds and jurisdiction-specific rules
around adult material are all outside what a codebase can check. If you are
operating commercially, get advice from someone qualified to give it.
