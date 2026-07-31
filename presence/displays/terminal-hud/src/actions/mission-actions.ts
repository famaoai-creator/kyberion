import { hudExec, distScript } from './exec.js';
import { auditAction, type ActionResult } from './dispatch.js';

export type MissionActionKind =
  'start' | 'pause' | 'resume' | 'checkpoint' | 'verify' | 'finish' | 'cancel';

const ARGS: Record<MissionActionKind, (id: string) => string[]> = {
  start: (id) => ['start', id],
  pause: (id) => ['pause', id],
  resume: (id) => ['resume', id],
  checkpoint: (id) => ['checkpoint', id, 'terminal-hud', 'checkpoint from terminal HUD'],
  verify: (id) => ['verify', id, 'verified', 'verified from terminal HUD'],
  finish: (id) => ['finish', id],
  cancel: (id) => ['cancel', id, '--note', 'cancelled from terminal HUD'],
};

/**
 * Mission mutations must go through scripts/mission_controller.ts (AGENTS.md
 * invariant); the controller is spawned so its exit semantics and identity
 * resolution stay intact, and a controller failure cannot take the HUD down.
 */
export function runMissionAction(kind: MissionActionKind, missionId: string): ActionResult {
  const result = hudExec('node', [distScript('mission_controller.js'), ...ARGS[kind](missionId)], {
    timeoutMs: 180000,
  });
  const lastLine =
    result.output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? '';
  return auditAction(`mission.${kind}`, { ok: result.ok, message: lastLine }, { missionId });
}

export const MISSION_ACTION_KEYS: Record<string, MissionActionKind> = {
  s: 'start',
  p: 'pause',
  u: 'resume',
  c: 'checkpoint',
  V: 'verify',
  F: 'finish',
  X: 'cancel',
};

export const MISSION_CONFIRM_ACTIONS: ReadonlySet<MissionActionKind> = new Set([
  'finish',
  'cancel',
  'verify',
]);
