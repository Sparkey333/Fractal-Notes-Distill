import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { paths } from "../core/paths.ts";
import { readJson, writeJson } from "../core/store.ts";
import { newId } from "../core/ids.ts";
import { getCharacter } from "../characters/store.ts";
import { checkLikeness, audit } from "../policy/likeness.ts";
import { getDefault, listProviders } from "../providers/registry.ts";
import { capabilityFor, type AssetSpec, type AssetStatus } from "./spec.ts";

/**
 * A durable job queue. Generation is slow, rate-limited and frequently
 * interrupted, so jobs live on disk with their full spec and provenance rather
 * than in memory. A crashed run resumes; a completed run remains auditable.
 */

export interface AssetJob {
  id: string;
  spec: AssetSpec;
  status: AssetStatus;
  provider?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  /** Files or URLs the provider returned. */
  outputs?: string[];
  error?: string;
  /**
   * Provenance stamped at submission. Recorded because "which consent covered
   * this render, under which policy verdict" is a question that gets asked long
   * after the render itself is forgotten.
   */
  provenance: {
    characterSlug?: string;
    likenessOrigin?: string;
    consentRecordId?: string;
    policyVerdict: "allowed" | "blocked";
    policyReason?: string;
  };
}

const jobFile = (id: string) => join(paths.jobs, `${id}.json`);

export function listJobs(filter?: { status?: AssetStatus; characterSlug?: string }): AssetJob[] {
  if (!existsSync(paths.jobs)) return [];
  return readdirSync(paths.jobs)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<AssetJob | undefined>(join(paths.jobs, f), undefined))
    .filter((j): j is AssetJob => j !== undefined)
    .filter((j) => !filter?.status || j.status === filter.status)
    .filter(
      (j) => !filter?.characterSlug || j.spec.characterSlug === filter.characterSlug,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getJob(id: string): AssetJob | undefined {
  const file = jobFile(id);
  return existsSync(file) ? readJson<AssetJob | undefined>(file, undefined) : undefined;
}

export function saveJob(job: AssetJob): AssetJob {
  writeJson(jobFile(job.id), job);
  return job;
}

/**
 * Enqueues a spec. The likeness check runs here rather than at execution time so
 * a blocked job is visible in the queue as a refusal with a reason, instead of
 * failing opaquely against a provider later.
 */
export function enqueue(spec: Omit<AssetSpec, "id"> & { id?: string }): AssetJob {
  const fullSpec: AssetSpec = { ...spec, id: spec.id ?? newId("asset") };
  const character = fullSpec.characterSlug
    ? getCharacter(fullSpec.characterSlug)
    : undefined;

  if (fullSpec.characterSlug && !character) {
    throw new Error(`No character "${fullSpec.characterSlug}".`);
  }

  const verdict = character
    ? checkLikeness(character.likeness, `${fullSpec.kind}:${character.contentRating}`)
    : { allowed: true as const };

  const job: AssetJob = {
    id: newId("job"),
    spec: fullSpec,
    status: verdict.allowed ? "queued" : "failed",
    provider: fullSpec.provider ?? resolveProvider(fullSpec),
    createdAt: new Date().toISOString(),
    attempts: 0,
    error: verdict.allowed ? undefined : `Blocked by likeness policy: ${verdict.reason}`,
    provenance: {
      characterSlug: fullSpec.characterSlug,
      likenessOrigin: character?.likeness.origin,
      consentRecordId: character?.likeness.consentRecordId,
      policyVerdict: verdict.allowed ? "allowed" : "blocked",
      policyReason: verdict.allowed ? undefined : verdict.reason,
    },
  };

  saveJob(job);
  audit("asset.enqueued", {
    jobId: job.id,
    kind: fullSpec.kind,
    characterSlug: fullSpec.characterSlug,
    verdict: job.provenance.policyVerdict,
  });
  return job;
}

/** Picks a provider by capability: explicit choice, configured default, else any configured one. */
function resolveProvider(spec: AssetSpec): string | undefined {
  const capability = capabilityFor(spec.kind);
  const configured = getDefault(capability);
  if (configured) return configured;
  return listProviders({ capability }).find((p) => p.configured)?.id;
}

export function markRunning(id: string): AssetJob {
  const job = requireJob(id);
  return saveJob({
    ...job,
    status: "running",
    startedAt: new Date().toISOString(),
    attempts: job.attempts + 1,
  });
}

export function markComplete(id: string, outputs: string[]): AssetJob {
  const job = requireJob(id);
  const done = saveJob({
    ...job,
    status: "complete",
    outputs,
    finishedAt: new Date().toISOString(),
    error: undefined,
  });
  audit("asset.completed", { jobId: id, outputs: outputs.length });
  return done;
}

export function markFailed(id: string, error: string): AssetJob {
  const job = requireJob(id);
  return saveJob({
    ...job,
    status: "failed",
    error,
    finishedAt: new Date().toISOString(),
  });
}

/** Returns a blocked job to the queue. Re-runs the policy check on the way. */
export function retry(id: string): AssetJob {
  const job = requireJob(id);
  const character = job.spec.characterSlug
    ? getCharacter(job.spec.characterSlug)
    : undefined;
  if (character) {
    const verdict = checkLikeness(
      character.likeness,
      `${job.spec.kind}:${character.contentRating}`,
    );
    if (!verdict.allowed) {
      throw new Error(`Still blocked by likeness policy: ${verdict.reason}`);
    }
  }
  return saveJob({ ...job, status: "queued", error: undefined });
}

export function requireJob(id: string): AssetJob {
  const job = getJob(id);
  if (!job) throw new Error(`No job ${id}.`);
  return job;
}

export interface QueueSummary {
  draft: number;
  queued: number;
  running: number;
  complete: number;
  failed: number;
  total: number;
}

export function summary(): QueueSummary {
  const jobs = listJobs();
  const counts: QueueSummary = {
    draft: 0, queued: 0, running: 0, complete: 0, failed: 0, total: jobs.length,
  };
  for (const job of jobs) counts[job.status]++;
  return counts;
}

/**
 * Renders a queued job as the request its provider expects. Kept separate from
 * execution so a spec can be inspected, diffed, or handed to an MCP client that
 * holds the credentials, rather than requiring this process to hold them.
 *
 * The likeness check runs again here, not only at enqueue time. A job can sit in
 * the queue for days, and consent revoked in the interim has to stop work that was
 * already approved — otherwise revocation only ever applies to jobs nobody has
 * submitted yet, which is the opposite of what a withdrawal means.
 */
export function renderRequest(job: AssetJob): {
  provider: string;
  capability: string;
  payload: Record<string, unknown>;
} {
  const provider = job.provider;
  if (!provider) {
    throw new Error(
      `Job ${job.id} has no provider. Configure one: studio provider use ` +
        `${capabilityFor(job.spec.kind)} <id>`,
    );
  }

  if (job.spec.characterSlug) {
    const character = getCharacter(job.spec.characterSlug);
    if (!character) {
      throw new Error(
        `Job ${job.id} references character "${job.spec.characterSlug}", which no longer exists.`,
      );
    }
    const verdict = checkLikeness(
      character.likeness,
      `${job.spec.kind}:${character.contentRating}`,
    );
    if (!verdict.allowed) {
      markFailed(job.id, `Blocked by likeness policy: ${verdict.reason}`);
      audit("asset.blocked_at_dispatch", {
        jobId: job.id,
        characterSlug: job.spec.characterSlug,
        reason: verdict.reason,
      });
      throw new Error(`Blocked by likeness policy: ${verdict.reason}`);
    }
  }

  const { spec } = job;
  return {
    provider,
    capability: capabilityFor(spec.kind),
    payload: {
      prompt: spec.prompt,
      ...(spec.negativePrompt ? { negative_prompt: spec.negativePrompt } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.width ? { width: spec.width } : {}),
      ...(spec.height ? { height: spec.height } : {}),
      ...(spec.durationSec ? { duration: spec.durationSec } : {}),
      ...(spec.fps ? { fps: spec.fps } : {}),
      ...(spec.seed !== undefined ? { seed: spec.seed } : {}),
      ...(spec.referenceAssetIds?.length
        ? { reference_assets: spec.referenceAssetIds }
        : {}),
    },
  };
}
