#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { ensureStudioTree, expandUserPath, paths } from "./core/paths.ts";
import { PROVIDER_CATALOG } from "./providers/catalog.ts";
import { deleteKey, maskKey, setKey } from "./providers/keystore.ts";
import {
  listProviders,
  probeAll,
  probeProvider,
  setBaseUrl,
  setDefault,
  getDefault,
} from "./providers/registry.ts";
import type { Capability } from "./providers/types.ts";
import {
  addMotion,
  createCharacter,
  deleteCharacter,
  listCharacters,
  requireCharacter,
} from "./characters/store.ts";
import type { CharacterDraft } from "./characters/schema.ts";
import { interact } from "./mind/mind.ts";
import { dream } from "./mind/dream.ts";
import { startHeartbeat, tick } from "./mind/heartbeat.ts";
import { beliefs, episodes, semantic } from "./mind/memory.ts";
import {
  ingestDirectory,
  listProjects,
  motionSummary,
  requireProject,
} from "./ingest/manifest.ts";
import { ffmpegAvailable } from "./ingest/ffmpeg.ts";
import { animationFromShot, buildPrompt } from "./assets/spec.ts";
import { enqueue, listJobs, renderRequest, requireJob, summary } from "./assets/queue.ts";
import { createConsentRecord, revokeConsent } from "./policy/likeness.ts";

const argv = process.argv.slice(2);

// ------------------------------------------------------------------ arg parsing

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(input: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < input.length; i++) {
    const token = input[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = input[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i++;
    }
  }
  return { positional, flags };
}

const str = (args: Args, name: string): string | undefined => {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
};
const num = (args: Args, name: string): number | undefined => {
  const value = str(args, name);
  return value === undefined ? undefined : Number(value);
};
const list = (args: Args, name: string): string[] | undefined => {
  const value = str(args, name);
  return value === undefined
    ? undefined
    : value.split(",").map((s) => s.trim()).filter(Boolean);
};

// ------------------------------------------------------------------- formatting

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0]!.map((_, col) =>
    Math.max(...rows.map((r) => stripAnsi(r[col] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1
            ? cell
            : cell + " ".repeat(Math.max(0, widths[i]! - stripAnsi(cell).length)),
        )
        .join("  "),
    )
    .join("\n");
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------- command

async function main(): Promise<void> {
  const args = parseArgs(argv);
  const [group, sub, ...rest] = args.positional;

  if (!group || group === "help" || args.flags.help) return usage();
  ensureStudioTree();

  switch (group) {
    case "init":
      return cmdInit();
    case "provider":
      return cmdProvider(sub, rest, args);
    case "character":
      return cmdCharacter(sub, rest, args);
    case "heartbeat":
      return cmdHeartbeat(args);
    case "ingest":
      return cmdIngest(sub, rest, args);
    case "project":
      return cmdProject(sub, rest, args);
    case "asset":
      return cmdAsset(sub, rest, args);
    case "consent":
      return cmdConsent(sub, rest, args);
    case "doctor":
      return cmdDoctor();
    default:
      console.error(red(`Unknown command "${group}".\n`));
      return usage();
  }
}

function usage(): void {
  console.log(`${bold("studio")} — character studio

${bold("Setup")}
  studio init                          create the studio tree
  studio doctor                        check providers and local tooling

${bold("Providers")}  ${dim("BYOK keys, local models, endpoints")}
  studio provider list [--capability text|image|video|voice|mesh3d]
  studio provider probe [<id>]         test reachability; no id probes all
  studio provider set-key <id> <key>   store a BYOK key (0600, gitignored)
  studio provider rm-key <id>
  studio provider set-url <id> <url>   override a local endpoint
  studio provider use <capability> <id>  set the default provider
  studio provider keys                 show which keys are loaded, masked

${bold("Characters")}
  studio character new --file <draft.json>
  studio character list
  studio character show <slug>
  studio character say <slug> "<text>" [--speaker <name>]
  studio character tick <slug>         one heartbeat tick
  studio character dream <slug> [--force]
  studio character memory <slug> [--limit <n>]
  studio character rm <slug>

${bold("Heartbeat")}
  studio heartbeat [--slugs a,b] [--once]

${bold("Ingest")}  ${dim("video → shots, motion profile, keyframes")}
  studio ingest <project-name> <dir> [--threshold 0.3] [--no-keyframes]
  studio project list
  studio project show <slug>
  studio project motions <slug> --character <slug> [--class gesture]

${bold("Assets")}
  studio asset new --character <slug> --kind <kind> --description "<text>"
  studio asset list [--status queued]
  studio asset show <job-id>
  studio asset request <job-id>        print the provider request payload

${bold("Consent")}  ${dim("required for any real-performer likeness")}
  studio consent add --name "<legal name>" --permitted "use1,use2" \\
      --method government-id --verified-by "<who>" --document-ref "<ref>"
  studio consent revoke <id>

State lives in ${dim(paths.root)} (override with STUDIO_HOME).
Set STUDIO_PASSPHRASE to encrypt stored keys at rest.`);
}

// ------------------------------------------------------------------------ init

function cmdInit(): void {
  ensureStudioTree();
  console.log(`${green("✓")} studio ready at ${bold(paths.root)}`);
  console.log(`
Next:
  1. ${bold("studio provider probe ollama")}      ${dim("— check a local model is up")}
  2. ${bold("studio provider use text ollama")}   ${dim("— route character minds to it")}
  3. ${bold("studio character new --file examples/character.example.json")}
  4. ${bold('studio character say <slug> "hello"')}`);
}

async function cmdDoctor(): Promise<void> {
  console.log(bold("Local tooling"));
  const tools = await ffmpegAvailable();
  console.log(
    table([
      ["  ffmpeg", tools.ffmpeg ? green("found") : red("missing")],
      ["  ffprobe", tools.ffprobe ? green("found") : red("missing")],
    ]),
  );
  if (tools.hint) console.log(dim(`  ${tools.hint}`));

  console.log(`\n${bold("Defaults")}`);
  const caps: Capability[] = ["text", "image", "video", "voice", "mesh3d"];
  console.log(
    table(caps.map((c) => [`  ${c}`, getDefault(c) ?? dim("(unset)")])),
  );

  console.log(`\n${bold("Reachable providers")}`);
  const statuses = await probeAll();
  const up = statuses.filter((s) => s.reachable);
  if (up.length === 0) {
    console.log(dim("  none — start a local model or add a key"));
  } else {
    console.log(
      table(
        up.map((s) => [
          `  ${green("●")} ${s.name}`,
          dim(s.baseUrl),
          s.models?.length ? dim(`${s.models.length} models`) : "",
        ]),
      ),
    );
  }
}

// -------------------------------------------------------------------- providers

async function cmdProvider(sub: string | undefined, rest: string[], args: Args): Promise<void> {
  switch (sub) {
    case undefined:
    case "list": {
      const capability = str(args, "capability") as Capability | undefined;
      const rows = listProviders(capability ? { capability } : undefined).map((p) => [
        `  ${p.configured ? green("●") : dim("○")} ${bold(p.id)}`,
        p.name,
        p.kind === "local" ? dim("local") : dim("cloud"),
        dim(p.capabilities.join(",")),
        p.configured
          ? p.kind === "local"
            ? dim("no key needed")
            : green(`key: ${p.keySource}`)
          : yellow(p.keyUrl),
      ]);
      console.log(bold("Providers") + dim("  ● configured / ○ needs a key\n"));
      console.log(table(rows));
      return;
    }

    case "probe": {
      const id = rest[0];
      const statuses = id ? [await probeProvider(id)] : await probeAll();
      console.log(
        table(
          statuses.map((s) => [
            `  ${s.reachable ? green("●") : red("○")} ${bold(s.id)}`,
            dim(s.baseUrl),
            s.reachable
              ? green(s.models?.length ? `up — ${s.models.length} models` : "up")
              : red(s.error ?? "unreachable"),
          ]),
        ),
      );
      return;
    }

    case "set-key": {
      const [id, key] = rest;
      if (!id || !key) throw new Error("Usage: studio provider set-key <id> <key>");
      setKey(id, key);
      console.log(`${green("✓")} stored key for ${bold(id)} ${dim(maskKey(id) ?? "")}`);
      console.log(dim(`  ${paths.keystore} (mode 0600, gitignored)`));
      return;
    }

    case "rm-key": {
      const id = rest[0];
      if (!id) throw new Error("Usage: studio provider rm-key <id>");
      console.log(
        deleteKey(id) ? `${green("✓")} removed key for ${id}` : dim(`no key stored for ${id}`),
      );
      return;
    }

    case "set-url": {
      const [id, url] = rest;
      if (!id || !url) throw new Error("Usage: studio provider set-url <id> <url>");
      setBaseUrl(id, url);
      console.log(`${green("✓")} ${id} → ${url}`);
      return;
    }

    case "use": {
      const [capability, id] = rest;
      if (!capability || !id) {
        throw new Error("Usage: studio provider use <capability> <provider-id>");
      }
      setDefault(capability as Capability, id);
      console.log(`${green("✓")} default ${bold(capability)} provider is now ${bold(id)}`);
      return;
    }

    case "keys": {
      const rows = PROVIDER_CATALOG.filter((p) => p.kind === "cloud").map((p) => {
        const masked = maskKey(p.id);
        return [
          `  ${masked ? green("●") : dim("○")} ${bold(p.id)}`,
          masked ? dim(masked) : yellow("get a key: " + p.keyUrl),
          p.envVar ? dim(`env: ${p.envVar}`) : "",
        ];
      });
      console.log(table(rows));
      return;
    }

    default:
      throw new Error(`Unknown: studio provider ${sub}`);
  }
}

// -------------------------------------------------------------------- character

async function cmdCharacter(sub: string | undefined, rest: string[], args: Args): Promise<void> {
  switch (sub) {
    case "new": {
      const file = str(args, "file");
      if (!file) {
        throw new Error(
          "Usage: studio character new --file <draft.json>\n" +
            "See examples/character.example.json for the shape.",
        );
      }
      const draft = JSON.parse(
        readFileSync(expandUserPath(file), "utf8"),
      ) as CharacterDraft;
      const character = createCharacter(draft);
      console.log(`${green("✓")} created ${bold(character.name)} ${dim(character.slug)}`);
      console.log(dim(`  likeness: ${character.likeness.origin}`));
      console.log(dim(`  mind: ${character.mind.model} @ ${character.mind.heartbeatPerHour}/hr`));
      return;
    }

    case undefined:
    case "list": {
      const characters = listCharacters();
      if (characters.length === 0) {
        console.log(dim("No characters yet. studio character new --file <draft.json>"));
        return;
      }
      console.log(
        table(
          characters.map((c) => [
            `  ${bold(c.slug)}`,
            c.name,
            dim(c.contentRating),
            dim(`${c.motions.length} motions`),
            dim(c.likeness.origin),
          ]),
        ),
      );
      return;
    }

    case "show": {
      const slug = rest[0];
      if (!slug) throw new Error("Usage: studio character show <slug>");
      const character = requireCharacter(slug);
      const state = semantic(slug);
      console.log(bold(character.name) + (character.tagline ? dim(` — ${character.tagline}`) : ""));
      console.log(dim(`${character.slug} · ${character.contentRating} · rev ${character.revision}`));
      console.log(`\n${character.persona.summary}`);
      if (character.persona.traits.length) {
        console.log(dim(`\ntraits: ${character.persona.traits.join(", ")}`));
      }
      console.log(dim(`likeness: ${character.likeness.origin}`));
      console.log(
        dim(`mood: valence ${state.mood.valence.toFixed(2)}, arousal ${state.mood.arousal.toFixed(2)}`),
      );
      console.log(dim(`memory: ${episodes(slug).length} episodes, ${beliefs(slug).length} beliefs`));
      if (character.motions.length) {
        console.log(`\n${bold("Motions")}`);
        console.log(
          table(character.motions.map((m) => [`  ${m.name}`, dim(m.description.slice(0, 70))])),
        );
      }
      return;
    }

    case "say": {
      const [slug, ...words] = rest;
      const text = words.join(" ");
      if (!slug || !text) throw new Error('Usage: studio character say <slug> "<text>"');
      const result = await interact(slug, text, { speaker: str(args, "speaker") });
      console.log(`\n${bold(requireCharacter(slug).name)}: ${result.reply}\n`);
      console.log(dim(`  ${result.provider}/${result.model}`));
      return;
    }

    case "tick": {
      const slug = rest[0];
      if (!slug) throw new Error("Usage: studio character tick <slug>");
      const result = await tick(slug);
      if (result.error) {
        console.log(red(`tick failed: ${result.error}`));
        return;
      }
      if (result.thought) console.log(`${dim("thought:")} ${result.thought}`);
      if (result.dreamed) {
        console.log(
          green(
            `dreamed: ${result.dreamed.episodesProcessed} episodes → ` +
              `${result.dreamed.beliefsFormed} beliefs`,
          ),
        );
      }
      return;
    }

    case "dream": {
      const slug = rest[0];
      if (!slug) throw new Error("Usage: studio character dream <slug> [--force]");
      const result = await dream(slug, { force: args.flags.force === true });
      if (result.skipped) {
        console.log(dim(result.skipped));
        return;
      }
      console.log(
        green(`${result.episodesProcessed} episodes → ${result.beliefsFormed} beliefs`),
      );
      if (result.narrative) console.log(`\n${dim(result.narrative)}\n`);
      for (const belief of beliefs(slug).slice(-result.beliefsFormed)) {
        console.log(`  ${belief.confidence.toFixed(2)}  ${belief.statement}`);
      }
      return;
    }

    case "memory": {
      const slug = rest[0];
      if (!slug) throw new Error("Usage: studio character memory <slug>");
      const limit = num(args, "limit") ?? 20;
      const recent = episodes(slug).slice(-limit);
      console.log(
        table(
          recent.map((e) => [
            dim(`  ${e.at.slice(5, 16).replace("T", " ")}`),
            dim(e.kind.padEnd(11)),
            e.content.slice(0, 90),
          ]),
        ),
      );
      const held = beliefs(slug);
      if (held.length) {
        console.log(`\n${bold("Beliefs")}`);
        console.log(
          table(
            [...held]
              .sort((a, b) => b.confidence - a.confidence)
              .map((b) => [`  ${b.confidence.toFixed(2)}`, b.statement]),
          ),
        );
      }
      return;
    }

    case "rm": {
      const slug = rest[0];
      if (!slug) throw new Error("Usage: studio character rm <slug>");
      console.log(
        deleteCharacter(slug)
          ? `${green("✓")} deleted ${slug} and all its memory`
          : dim(`no character ${slug}`),
      );
      return;
    }

    default:
      throw new Error(`Unknown: studio character ${sub}`);
  }
}

// -------------------------------------------------------------------- heartbeat

async function cmdHeartbeat(args: Args): Promise<void> {
  const slugs = list(args, "slugs");

  if (args.flags.once) {
    const targets = slugs ?? listCharacters().map((c) => c.slug);
    for (const slug of targets) {
      const result = await tick(slug);
      const detail = result.error
        ? red(result.error)
        : (result.thought ?? dim("(no thought)"));
      console.log(`${bold(slug.padEnd(16))} ${detail}`);
    }
    return;
  }

  const scheduler = startHeartbeat({
    ...(slugs ? { slugs } : {}),
    onTick: (result) => {
      const stamp = dim(result.at.slice(11, 19));
      if (result.error) {
        console.log(`${stamp} ${bold(result.slug)} ${red(result.error)}`);
        return;
      }
      if (result.thought) console.log(`${stamp} ${bold(result.slug)} ${result.thought}`);
      if (result.dreamed) {
        console.log(
          `${stamp} ${bold(result.slug)} ` +
            green(`dreamed ${result.dreamed.episodesProcessed} → ${result.dreamed.beliefsFormed} beliefs`),
        );
      }
    },
  });

  const roster = scheduler.roster();
  if (roster.length === 0) {
    console.log(dim("No characters have a heartbeat configured (mind.heartbeatPerHour)."));
    scheduler.stop();
    return;
  }
  console.log(bold("Heartbeat running") + dim("  ctrl-c to stop\n"));
  console.log(table(roster.map((r) => [`  ${r.slug}`, dim(`every ${r.everyMinutes}m`)])));

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      scheduler.stop();
      console.log(dim("\nstopped"));
      resolve();
    });
  });
}

// ----------------------------------------------------------------------- ingest

async function cmdIngest(sub: string | undefined, rest: string[], args: Args): Promise<void> {
  const name = sub;
  const dir = rest[0];
  if (!name || !dir) {
    throw new Error("Usage: studio ingest <project-name> <directory>");
  }
  const resolved = expandUserPath(dir);
  console.log(dim(`scanning ${resolved}`));

  const project = await ingestDirectory(name, resolved, {
    threshold: num(args, "threshold") ?? 0.3,
    keyframes: args.flags["no-keyframes"] !== true,
    onProgress: (message) => console.log(dim(`  ${message}`)),
  });

  const shots = project.media.reduce((n, m) => n + m.shots.length, 0);
  console.log(
    `\n${green("✓")} ${bold(project.slug)} — ${project.media.length} files, ${shots} shots`,
  );
  console.log(dim(`  likeness use is denied on all sources by default`));
  console.log(dim(`  studio project show ${project.slug}`));
}

function cmdProject(sub: string | undefined, rest: string[], args: Args): void {
  switch (sub) {
    case undefined:
    case "list": {
      const projects = listProjects();
      if (projects.length === 0) {
        console.log(dim("No projects. studio ingest <name> <dir>"));
        return;
      }
      console.log(
        table(
          projects.map((p) => [
            `  ${bold(p.slug)}`,
            p.name,
            dim(`${p.media.length} files`),
            dim(`${p.media.reduce((n, m) => n + m.shots.length, 0)} shots`),
          ]),
        ),
      );
      return;
    }

    case "show": {
      const slug = rest[0];
      if (!slug) throw new Error("Usage: studio project show <slug>");
      const project = requireProject(slug);
      console.log(bold(project.name) + dim(` — ${project.sourceDir ?? ""}`));

      for (const media of project.media) {
        const info = media.info;
        console.log(`\n  ${bold(media.filename)} ${dim(media.key)}`);
        if (info) {
          console.log(
            dim(
              `    ${info.width}×${info.height} · ${info.fps}fps · ` +
                `${info.durationSec.toFixed(1)}s · ${info.hasAudio ? "audio" : "silent"}`,
            ),
          );
        }
        if (media.analysisError) console.log(red(`    ${media.analysisError}`));
        console.log(dim(`    likeness use: ${media.likenessUse}`));
        if (media.shots.length > 0) {
          const byClass = new Map<string, number>();
          for (const shot of media.shots) {
            byClass.set(shot.motionClass, (byClass.get(shot.motionClass) ?? 0) + 1);
          }
          console.log(
            dim(
              `    ${media.shots.length} shots — ` +
                [...byClass].map(([k, n]) => `${n} ${k}`).join(", "),
            ),
          );
        }
      }

      const summaryByClass = motionSummary(project);
      console.log(`\n  ${bold("Motion inventory")}`);
      console.log(
        table(
          Object.entries(summaryByClass).map(([cls, shots]) => [
            `    ${cls}`,
            dim(`${shots.length} shots`),
            dim(
              shots.length
                ? `${(shots.reduce((n, s) => n + s.durationSec, 0)).toFixed(1)}s total`
                : "",
            ),
          ]),
        ),
      );
      return;
    }

    case "motions": {
      const slug = rest[0];
      const characterSlug = str(args, "character");
      if (!slug || !characterSlug) {
        throw new Error(
          "Usage: studio project motions <project> --character <slug> [--class gesture]",
        );
      }
      const project = requireProject(slug);
      const wanted = str(args, "class");
      const character = requireCharacter(characterSlug);

      let added = 0;
      for (const media of project.media) {
        for (const shot of media.shots) {
          if (wanted && shot.motionClass !== wanted) continue;
          if (shot.motionClass === "static") continue;
          addMotion(characterSlug, {
            name: `${media.key}-${shot.motionClass}-${shot.index}`,
            description:
              shot.note ??
              `${shot.motionClass} movement, ${shot.durationSec.toFixed(1)}s, ` +
                `energy ${shot.motionEnergy.toFixed(3)}`,
            sourceShotIds: [shot.id],
            durationSec: shot.durationSec,
            tags: [shot.motionClass, project.slug],
          });
          added++;
        }
      }
      console.log(
        `${green("✓")} added ${added} motions to ${bold(character.name)}` +
          dim("  (timing and class only — no imagery carried over)"),
      );
      console.log(
        dim(`  describe them properly with: studio character show ${characterSlug}`),
      );
      return;
    }

    default:
      throw new Error(`Unknown: studio project ${sub}`);
  }
}

// ------------------------------------------------------------------------ asset

function cmdAsset(sub: string | undefined, rest: string[], args: Args): void {
  switch (sub) {
    case "new": {
      const characterSlug = str(args, "character");
      const kind = (str(args, "kind") ?? "reference") as Parameters<typeof buildPrompt>[1]["kind"];
      const description = str(args, "description");
      if (!description) {
        throw new Error(
          'Usage: studio asset new --character <slug> --kind <kind> --description "<text>"',
        );
      }
      const character = characterSlug ? requireCharacter(characterSlug) : undefined;
      const prompt = buildPrompt(character, {
        kind,
        description,
        ...(str(args, "motion") ? { motion: { description: str(args, "motion")! } } : {}),
        ...(str(args, "prop")
          ? {
              prop: {
                name: str(args, "prop")!,
                affordances: {
                  accepts: list(args, "accepts") ?? [],
                  ...(str(args, "material")
                    ? { material: str(args, "material") as "rigid" }
                    : {}),
                  ...(num(args, "weight") !== undefined ? { weight: num(args, "weight") } : {}),
                },
              },
            }
          : {}),
        ...(str(args, "environment") ? { environment: str(args, "environment")! } : {}),
      });

      const job = enqueue({
        kind,
        name: str(args, "name") ?? `${characterSlug ?? "standalone"}-${kind}`,
        characterSlug,
        prompt,
        provider: str(args, "provider"),
        model: str(args, "model"),
        width: num(args, "width"),
        height: num(args, "height"),
        durationSec: num(args, "duration"),
        seed: num(args, "seed"),
        referenceAssetIds: character?.appearance.referenceAssetIds ?? [],
      });

      if (job.status === "failed") {
        console.log(red(`✗ ${job.error}`));
        return;
      }
      console.log(`${green("✓")} queued ${bold(job.id)} ${dim(`→ ${job.provider ?? "no provider"}`)}`);
      console.log(dim(`\n${job.spec.prompt}\n`));
      console.log(dim(`  studio asset request ${job.id}   # see the provider payload`));
      return;
    }

    case undefined:
    case "list": {
      const jobs = listJobs({
        ...(str(args, "status") ? { status: str(args, "status") as "queued" } : {}),
        ...(str(args, "character") ? { characterSlug: str(args, "character")! } : {}),
      });
      const counts = summary();
      console.log(
        dim(
          `${counts.total} jobs — ${counts.queued} queued, ${counts.running} running, ` +
            `${counts.complete} complete, ${counts.failed} failed\n`,
        ),
      );
      console.log(
        table(
          jobs.map((j) => [
            `  ${statusDot(j.status)} ${bold(j.id)}`,
            dim(j.spec.kind.padEnd(11)),
            j.spec.characterSlug ?? dim("—"),
            dim(j.provider ?? "no provider"),
            j.error ? red(j.error.slice(0, 60)) : dim(j.spec.name),
          ]),
        ),
      );
      return;
    }

    case "show": {
      const id = rest[0];
      if (!id) throw new Error("Usage: studio asset show <job-id>");
      const job = requireJob(id);
      console.log(bold(job.id) + ` ${statusDot(job.status)} ${job.status}`);
      console.log(dim(`${job.spec.kind} · ${job.spec.name} · ${job.provider ?? "no provider"}`));
      console.log(`\n${job.spec.prompt}\n`);
      if (job.spec.motionReference) {
        const ref = job.spec.motionReference;
        console.log(
          dim(`motion ref: ${ref.motionClass}, ${ref.durationSec}s (timing only, from ${ref.shotId})`),
        );
      }
      console.log(
        dim(
          `provenance: ${job.provenance.likenessOrigin ?? "n/a"} · ` +
            `${job.provenance.policyVerdict}` +
            (job.provenance.consentRecordId ? ` · ${job.provenance.consentRecordId}` : ""),
        ),
      );
      if (job.error) console.log(red(`\n${job.error}`));
      if (job.outputs?.length) console.log(`\n${green("outputs")}\n  ${job.outputs.join("\n  ")}`);
      return;
    }

    case "request": {
      const id = rest[0];
      if (!id) throw new Error("Usage: studio asset request <job-id>");
      console.log(JSON.stringify(renderRequest(requireJob(id)), null, 2));
      return;
    }

    default:
      throw new Error(`Unknown: studio asset ${sub}`);
  }
}

function statusDot(status: string): string {
  switch (status) {
    case "complete": return green("●");
    case "failed": return red("●");
    case "running": return yellow("●");
    default: return dim("○");
  }
}

// ---------------------------------------------------------------------- consent

function cmdConsent(sub: string | undefined, rest: string[], args: Args): void {
  switch (sub) {
    case "add": {
      const performerName = str(args, "name");
      const permitted = list(args, "permitted");
      const method = str(args, "method") as "government-id" | undefined;
      const verifiedBy = str(args, "verified-by");
      const documentRef = str(args, "document-ref");

      if (!performerName || !permitted?.length || !method || !verifiedBy || !documentRef) {
        throw new Error(
          "Usage: studio consent add --name \"<legal name>\" --permitted \"use1,use2\" \\\n" +
            "    --method government-id|third-party-service|notarized-declaration \\\n" +
            "    --verified-by \"<who verified>\" --document-ref \"<record system ref>\" \\\n" +
            "    [--withheld \"use3\"] [--expires 2027-01-01]",
        );
      }

      const record = createConsentRecord({
        performerName,
        ageVerification: {
          method,
          verifiedBy,
          verifiedAt: new Date().toISOString(),
          documentRef,
        },
        permittedUses: permitted,
        withheldUses: list(args, "withheld") ?? [],
        ...(str(args, "expires") ? { expiresAt: new Date(str(args, "expires")!).toISOString() } : {}),
      });

      console.log(`${green("✓")} consent record ${bold(record.id)} for ${record.performerName}`);
      console.log(dim(`  permitted: ${record.permittedUses.join(", ")}`));
      if (record.withheldUses.length) console.log(dim(`  withheld: ${record.withheldUses.join(", ")}`));
      console.log(
        dim(
          `\n  Reference it from a character with:\n` +
            `    "likeness": { "origin": "consented-performer", "consentRecordId": "${record.id}" }`,
        ),
      );
      return;
    }

    case "revoke": {
      const id = rest[0];
      if (!id) throw new Error("Usage: studio consent revoke <id>");
      const record = revokeConsent(id);
      console.log(
        `${green("✓")} revoked consent for ${record.performerName}. ` +
          dim("All queued and future jobs using this record will now be blocked."),
      );
      return;
    }

    default:
      throw new Error(`Unknown: studio consent ${sub}`);
  }
}

main().catch((err: unknown) => {
  console.error(red(`\n${err instanceof Error ? err.message : String(err)}\n`));
  process.exit(1);
});
