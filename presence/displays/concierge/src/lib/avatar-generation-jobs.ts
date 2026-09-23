import { randomUUID } from 'node:crypto';
import { buildExecutionEnv } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResultAsync } from '@agent/core/secure-io';

/**
 * PA-10: the concierge "create an avatar from this photo" job. The generator
 * runs as `dist/scripts/generate_avatar.js` in a child process (like the
 * ingest ceremony) under the concierge execution identity — the photo is
 * read straight from the active profile root and nothing is copied. The job
 * record keeps only status codes and the provider id, never script output.
 */
export const AVATAR_SCRIPT_RELATIVE = 'dist/scripts/generate_avatar.js';
const RESULT_PREFIX = 'AVATAR_SET_RESULT ';
const PLAN_PREFIX = 'AVATAR_PLAN ';
const GENERATION_TIMEOUT_MS = 20 * 60 * 1000;
const PLAN_TIMEOUT_MS = 60 * 1000;
const JOB_TTL_MS = 60 * 60 * 1000;
export const AVATAR_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_]{1,39}$/u;

export interface AvatarGenerationPlan {
  provider_id: string;
  display_name: string;
  data_egress: 'local' | 'cloud';
  requires_consent: boolean;
  interactive_handoff: boolean;
}

export type AvatarJobStatus = 'running' | 'succeeded' | 'handoff' | 'failed';
/** Stable reason codes the UI maps to vocabulary (no raw script output). */
export type AvatarJobReason = 'consent_denied' | 'no_provider' | 'generation_failed';

export interface AvatarGenerationJob {
  id: string;
  status: AvatarJobStatus;
  provider_id: string;
  started_at: string;
  finished_at?: string;
  reason?: AvatarJobReason;
  /** Host hand-off: the manifest the host agent must fulfil before a rerun. */
  handoff_manifest?: string;
}

type ScriptResult = { stdout: string; stderr: string; status: number | null };
export type AvatarScriptRunner = (args: string[], timeoutMs: number) => Promise<ScriptResult>;

const defaultRunner: AvatarScriptRunner = (args, timeoutMs) =>
  safeExecResultAsync(process.execPath, [AVATAR_SCRIPT_RELATIVE, ...args], {
    env: buildExecutionEnv(process.env, 'sovereign_concierge'),
    cwd: pathResolver.rootDir(),
    timeoutMs,
    maxOutputMB: 5,
  });

const STORE_KEY = Symbol.for('kyberion.concierge.avatar-generation-jobs');
type Store = { jobs: Map<string, AvatarGenerationJob>; runner: AvatarScriptRunner };
function store(): Store {
  const holder = globalThis as unknown as Record<symbol, Store | undefined>;
  holder[STORE_KEY] ??= { jobs: new Map(), runner: defaultRunner };
  return holder[STORE_KEY]!;
}

export function _setAvatarScriptRunnerForTests(runner: AvatarScriptRunner | null): void {
  store().runner = runner ?? defaultRunner;
  store().jobs.clear();
}

/** The JSON payload of the last `<prefix>{...}` line, or null. */
export function parseAvatarScriptLine(
  stdout: string,
  prefix: string
): Record<string, unknown> | null {
  const line = stdout
    .split(/\r?\n/u)
    .reverse()
    .find((entry) => entry.startsWith(prefix));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function photoArgs(photoPath: string, outputDir: string): string[] {
  return [
    '--input-photo',
    pathResolver.toRepoRelative(photoPath),
    '--output-dir',
    pathResolver.toRepoRelative(outputDir),
  ];
}

function parsePlan(value: unknown): AvatarGenerationPlan | null {
  if (!value || typeof value !== 'object') return null;
  const plan = value as Record<string, unknown>;
  if (typeof plan.provider_id !== 'string' || !AVATAR_PROVIDER_ID_PATTERN.test(plan.provider_id)) {
    return null;
  }
  return {
    provider_id: plan.provider_id,
    display_name: typeof plan.display_name === 'string' ? plan.display_name : plan.provider_id,
    data_egress: plan.data_egress === 'local' ? 'local' : 'cloud',
    requires_consent: plan.data_egress !== 'local',
    interactive_handoff: plan.interactive_handoff === true,
  };
}

/** Which provider a run would send the photo to — nothing is generated or sent. */
export async function planAvatarGeneration(
  photoPath: string,
  outputDir: string
): Promise<AvatarGenerationPlan | null> {
  const result = await store().runner(
    [...photoArgs(photoPath, outputDir), '--plan'],
    PLAN_TIMEOUT_MS
  );
  if (result.status !== 0) return null;
  return parsePlan(parseAvatarScriptLine(result.stdout, PLAN_PREFIX)?.plan);
}

function prune(now: number): void {
  for (const [id, job] of store().jobs) {
    if (job.status !== 'running' && now - Date.parse(job.started_at) > JOB_TTL_MS) {
      store().jobs.delete(id);
    }
  }
}

export function runningAvatarGenerationJob(): AvatarGenerationJob | null {
  return [...store().jobs.values()].find((job) => job.status === 'running') ?? null;
}

export function getAvatarGenerationJob(id: string): AvatarGenerationJob | null {
  return store().jobs.get(id) ?? null;
}

function classifyFailure(output: string): AvatarJobReason {
  if (output.includes('IMAGE_REFERENCE_EGRESS_DENIED')) return 'consent_denied';
  if (output.includes('No available Image Generation provider')) return 'no_provider';
  return 'generation_failed';
}

/**
 * Start one generation run for `providerId`. `grantedBy` is the server-resolved
 * principal that confirmed the consent dialog; the per-run consent itself is
 * created (and time-stamped) by the generator for exactly that provider.
 */
export function startAvatarGenerationJob(input: {
  photoPath: string;
  outputDir: string;
  providerId: string;
  grantedBy: string;
}): AvatarGenerationJob {
  if (!AVATAR_PROVIDER_ID_PATTERN.test(input.providerId)) {
    throw new Error('invalid avatar provider id');
  }
  const now = Date.now();
  prune(now);
  const job: AvatarGenerationJob = {
    id: randomUUID(),
    status: 'running',
    provider_id: input.providerId,
    started_at: new Date(now).toISOString(),
  };
  store().jobs.set(job.id, job);
  const args = [
    ...photoArgs(input.photoPath, input.outputDir),
    '--bridge-preference',
    input.providerId,
    '--consent-provider',
    input.providerId,
    '--consent-granted-by',
    input.grantedBy,
  ];
  void store()
    .runner(args, GENERATION_TIMEOUT_MS)
    .then((result) => {
      const verdict = parseAvatarScriptLine(result.stdout, RESULT_PREFIX);
      // Exit code 0 alone is not success: the generator's own verdict must say so.
      if (result.status === 0 && verdict?.status === 'succeeded') {
        job.status = 'succeeded';
        if (typeof verdict.provider_id === 'string') job.provider_id = verdict.provider_id;
      } else if (result.status === 100 && verdict?.status === 'handoff') {
        job.status = 'handoff';
        job.handoff_manifest = 'active/shared/tmp/avatar-set-handoff.json';
      } else {
        job.status = 'failed';
        job.reason = classifyFailure(
          `${typeof verdict?.message === 'string' ? verdict.message : ''}\n${result.stderr}`
        );
        console.error(
          `[concierge/avatar] generation failed exit=${result.status} reason=${job.reason}`
        );
      }
    })
    .catch(() => {
      job.status = 'failed';
      job.reason = 'generation_failed';
    })
    .finally(() => {
      job.finished_at = new Date().toISOString();
    });
  return job;
}
