import path from 'node:path';
import {
  listScheduledPipelines,
  registerScheduledPipeline,
  unregisterScheduledPipeline,
} from '@agent/core/pipeline-scheduler';
import { spawnManagedProcess } from '@agent/core/managed-process';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { distScript } from './exec.js';
import { auditAction, toActionResult, HUD_PEER_ID, type ActionResult } from './dispatch.js';

function findSchedule(id: string) {
  return listScheduledPipelines().find((schedule) => schedule.id === id);
}

export function resolvePipelineFile(pipelinePath: string, root: string): string | null {
  try {
    const resolved = assertSafeRepositoryPath(path.resolve(root, pipelinePath), {
      allowMissingLeaf: true,
    });
    return safeExistsSync(resolved) && safeLstat(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

export function toggleSchedule(id: string): ActionResult {
  try {
    const schedule = findSchedule(id);
    if (!schedule) return { ok: false, message: `not found: ${id}` };
    registerScheduledPipeline({ ...schedule, enabled: !schedule.enabled });
    return auditAction(
      'schedule.toggle',
      { ok: true, message: `${id}: ${schedule.enabled ? 'disabled' : 'enabled'}` },
      { id }
    );
  } catch (err) {
    return auditAction('schedule.toggle', toActionResult(err), { id });
  }
}

export function removeSchedule(id: string): ActionResult {
  try {
    unregisterScheduledPipeline(id);
    return auditAction('schedule.remove', { ok: true, message: `unregistered ${id}` }, { id });
  } catch (err) {
    return auditAction('schedule.remove', toActionResult(err), { id });
  }
}

/**
 * Run a scheduled pipeline immediately as a detached managed child process.
 * runSteps is deliberately not called in-process: a pipeline must not block
 * or crash the UI loop.
 */
export function runScheduleNow(id: string): ActionResult {
  try {
    const schedule = findSchedule(id);
    if (!schedule) return { ok: false, message: `not found: ${id}` };
    const pipelinePath = resolvePipelineFile(schedule.pipelinePath, pathResolver.rootDir());
    if (!pipelinePath) {
      return { ok: false, message: `pipeline missing: ${schedule.pipelinePath}` };
    }
    const handle = spawnManagedProcess({
      resourceId: `terminal-hud-run-${id}-${Date.now().toString(36)}`,
      kind: 'service',
      ownerId: HUD_PEER_ID,
      ownerType: 'operator_surface',
      command: 'node',
      args: [distScript('run_pipeline.js'), '--input', pipelinePath, '--quiet'],
      spawnOptions: { cwd: pathResolver.rootDir(), stdio: 'ignore', detached: true },
      shutdownPolicy: 'detached',
    });
    return auditAction(
      'schedule.run_now',
      { ok: true, message: `spawned ${handle.resourceId}` },
      { id, pipelinePath: schedule.pipelinePath }
    );
  } catch (err) {
    return auditAction('schedule.run_now', toActionResult(err), { id });
  }
}

export function registerScheduleFromPalette(input: {
  id: string;
  pipelinePath: string;
  cron: string;
}): ActionResult {
  try {
    const root = pathResolver.rootDir();
    const candidate = path.resolve(root, input.pipelinePath);
    const pipelinesRoot = path.resolve(root, 'pipelines');
    if (candidate !== pipelinesRoot && !candidate.startsWith(pipelinesRoot + path.sep)) {
      return { ok: false, message: 'pipeline must live under pipelines/' };
    }
    const resolved = resolvePipelineFile(input.pipelinePath, root);
    if (!resolved) {
      return { ok: false, message: `pipeline missing: ${input.pipelinePath}` };
    }
    registerScheduledPipeline({
      id: input.id,
      name: input.id,
      pipelinePath: input.pipelinePath,
      actuator: 'system',
      trigger: { type: 'cron', cron: input.cron },
      enabled: true,
    });
    return auditAction('schedule.register', { ok: true, message: `registered ${input.id}` }, input);
  } catch (err) {
    return auditAction('schedule.register', toActionResult(err), { id: input.id });
  }
}
