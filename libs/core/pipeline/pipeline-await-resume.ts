/**
 * Resume scanner for `core:await_state` suspensions.
 *
 * `await_decision` resumes from an approval-store write hook; `await_state`
 * has no writer event to hook, so a periodic scanner plays that role: it
 * walks the run journals, re-evaluates each suspended state probe, and
 * respawns the run when the condition is satisfied or the timeout elapsed.
 * The resumed step re-evaluates the probe itself — the scanner is only the
 * alarm clock, the step remains the authority on whether it may continue.
 *
 * Same durable discipline as pipeline-approval-resume: journals are the
 * source of truth, spawn is managed + deduped in flight, and a finished or
 * externally-resumed run is never double-spawned.
 */

import * as path from 'node:path';
import { spawnManagedProcess } from '../managed-process.js';
import { loadPipelineRunJournal } from './pipeline-run-journal.js';
import { evaluateStateProbe, type StateProbeDeps, type StateProbeSpec } from '../state-probe.js';
import { pathResolver, shared, rootDir } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from '../secure-io.js';

export interface AwaitResumeOutcome {
  runId: string;
  status: 'resumed' | 'waiting' | 'finished' | 'error';
  reason?: string;
}

export interface AwaitResumeScanDeps {
  now?: () => Date;
  serviceCall?: StateProbeDeps['serviceCall'];
  /** Injectable spawner for tests; defaults to spawnManagedProcess. */
  spawn?: typeof spawnManagedProcess;
}

const pendingResumes = new Set<string>();

/** Test seam: clear in-flight resume state between cases. */
export function resetAwaitResumeState(): void {
  pendingResumes.clear();
}

function journalFiles(): string[] {
  const files: string[] = [];
  const collect = (dir: string) => {
    if (!safeExistsSync(dir)) return;
    for (const name of safeReaddir(dir)) {
      const full = path.join(dir, name);
      try {
        if (safeLstat(full).isFile() && name.endsWith('.jsonl')) files.push(full);
      } catch {
        continue;
      }
    }
  };
  collect(shared('runtime/pipeline-runs'));
  for (const tier of ['confidential', 'public'] as const) {
    const base = path.join(rootDir(), 'active', 'missions', tier);
    if (!safeExistsSync(base)) continue;
    for (const missionId of safeReaddir(base)) {
      collect(path.join(base, missionId, 'coordination', 'pipeline-runs'));
    }
  }
  return files;
}

function runIdFromJournal(filePath: string): string | null {
  const name = path.basename(filePath, '.jsonl');
  return /^[A-Za-z0-9._-]+$/u.test(name) ? name : null;
}

/**
 * Evaluate one suspended run's probe and decide whether it should resume.
 * A timeout counts as resumable — the step's own on_timeout branch decides
 * deny vs abort, exactly like the approval path.
 */
async function shouldResume(
  suspended: {
    step_id: string;
    timeout_at?: string;
    state_probe?: Record<string, unknown>;
  },
  deps: AwaitResumeScanDeps
): Promise<{ resume: boolean; reason: string }> {
  const now = deps.now?.() ?? new Date();
  if (suspended.timeout_at && Date.parse(suspended.timeout_at) <= now.getTime()) {
    return { resume: true, reason: 'timeout reached — resume so on_timeout can apply' };
  }
  if (!suspended.state_probe) {
    return { resume: false, reason: 'state suspend without a probe spec' };
  }
  try {
    const result = await evaluateStateProbe(suspended.state_probe as StateProbeSpec, {
      serviceCall: deps.serviceCall,
    });
    return result.matched
      ? { resume: true, reason: `probe satisfied (fingerprint ${result.fingerprint})` }
      : { resume: false, reason: 'probe not satisfied' };
  } catch (error) {
    return {
      resume: false,
      reason: `probe evaluation failed: ${error instanceof Error ? error.message : error}`,
    };
  }
}

function spawnResume(
  runId: string,
  missionId: string | undefined,
  deps: AwaitResumeScanDeps
): void {
  const runnerPath = assertSafeRepositoryPath(
    pathResolver.rootResolve('dist/scripts/run_pipeline.js')
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (missionId) env.MISSION_ID = missionId;
  const spawn = deps.spawn ?? spawnManagedProcess;
  const handle = spawn({
    resourceId: `pipeline-await-resume:${runId}`,
    kind: 'service',
    ownerId: missionId || `pipeline:${runId}`,
    ownerType: 'pipeline-await-resume',
    command: process.execPath,
    args: [runnerPath, '--resume', runId],
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      env,
      detached: true,
      stdio: 'ignore',
    },
    shutdownPolicy: 'detached',
    metadata: { pipelineRunId: runId, awaitKind: 'state' },
  });
  handle.child.once('exit', () => pendingResumes.delete(`pipeline-await-resume:${runId}`));
}

/**
 * One scan pass over all suspended `await_kind === 'state'` runs. Called
 * from the chronos tick; per-run failures are reported in the outcome list,
 * never thrown into the tick loop.
 */
export async function sweepAwaitStateRuns(
  deps: AwaitResumeScanDeps = {}
): Promise<AwaitResumeOutcome[]> {
  const outcomes: AwaitResumeOutcome[] = [];
  const seen = new Set<string>();
  for (const filePath of journalFiles()) {
    const runId = runIdFromJournal(filePath);
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    const resourceId = `pipeline-await-resume:${runId}`;
    if (pendingResumes.has(resourceId)) {
      outcomes.push({ runId, status: 'waiting', reason: 'resume already in flight' });
      continue;
    }
    try {
      const state = loadPipelineRunJournal(runId);
      if (state.finished || !state.suspended) continue;
      const suspended = state.suspended;
      if ((suspended.await_kind ?? 'approval') !== 'state') continue;
      const decision = await shouldResume(suspended, deps);
      if (!decision.resume) {
        outcomes.push({ runId, status: 'waiting', reason: decision.reason });
        continue;
      }
      const missionId =
        typeof state.started?.mission_id === 'string' ? state.started.mission_id : undefined;
      pendingResumes.add(resourceId);
      try {
        spawnResume(runId, missionId, deps);
      } catch (error) {
        pendingResumes.delete(resourceId);
        throw error;
      }
      outcomes.push({ runId, status: 'resumed', reason: decision.reason });
    } catch (error) {
      outcomes.push({
        runId,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}
