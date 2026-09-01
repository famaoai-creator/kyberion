import { runMissionAction, type MissionActionKind } from './mission-actions.js';
import { runSurfaceAction, type SurfaceActionKind } from './surface-actions.js';
import { claimItem, releaseItem, advanceItemStatus } from './work-actions.js';
import {
  toggleSchedule,
  removeSchedule,
  runScheduleNow,
  registerScheduleFromPalette,
} from './schedule-actions.js';
import { createWorkItem } from '@agent/core/work-coordination';
import { auditAction, toActionResult, type ActionResult } from './dispatch.js';
import { isPanelId, type PanelId } from '../keymap.js';

export interface PaletteOutcome {
  result: ActionResult;
  switchPanel?: PanelId;
}

const MISSION_VERBS: ReadonlySet<string> = new Set([
  'start',
  'pause',
  'resume',
  'checkpoint',
  'verify',
  'finish',
  'cancel',
]);
const SURFACE_VERBS: ReadonlySet<string> = new Set(['start', 'stop', 'repair']);

export const PALETTE_USAGE = [
  ':panel <missions|tasks|schedules|processes|coordination|stats|profile|settings>',
  ':mission <start|pause|resume|checkpoint|verify|finish|cancel> <ID>',
  ':task <new <title...>|claim <ID>|release <ID>|status <ID>>',
  ':schedule <run|toggle|remove> <ID>',
  ':schedule add <ID> <pipelines/path.json> <cron...>',
  ':surface <start|stop|repair> <ID>',
];

/**
 * Whitelisted command palette: every verb maps onto the sanctioned action
 * registry — arbitrary shell commands are intentionally not expressible.
 */
export async function runPaletteCommand(raw: string): Promise<PaletteOutcome> {
  const tokens = raw.replace(/^:/, '').trim().split(/\s+/).filter(Boolean);
  const [group, verb, ...rest] = tokens;
  try {
    switch (group) {
      case 'panel': {
        if (verb && isPanelId(verb)) {
          return { result: { ok: true, message: `→ ${verb}` }, switchPanel: verb };
        }
        break;
      }
      case 'mission': {
        const id = rest[0];
        if (verb && MISSION_VERBS.has(verb) && id) {
          return { result: runMissionAction(verb as MissionActionKind, id) };
        }
        break;
      }
      case 'surface': {
        const id = rest[0];
        if (verb && SURFACE_VERBS.has(verb) && id) {
          return { result: runSurfaceAction(verb as SurfaceActionKind, id) };
        }
        break;
      }
      case 'task': {
        if (verb === 'new' && rest.length > 0) {
          const title = rest.join(' ');
          const item = createWorkItem({ title, description: title });
          return {
            result: auditAction('work.create', { ok: true, message: item.item_id }, { title }),
          };
        }
        const id = rest[0];
        if (verb === 'claim' && id) return { result: claimItem(id) };
        if (verb === 'release' && id) return { result: releaseItem(id) };
        if (verb === 'status' && id) return { result: advanceItemStatus(id) };
        break;
      }
      case 'schedule': {
        const id = rest[0];
        if (verb === 'run' && id) return { result: runScheduleNow(id) };
        if (verb === 'toggle' && id) return { result: toggleSchedule(id) };
        if (verb === 'remove' && id) return { result: removeSchedule(id) };
        if (verb === 'add' && rest.length >= 3) {
          const [scheduleId, pipelinePath, ...cronParts] = rest;
          return {
            result: registerScheduleFromPalette({
              id: scheduleId,
              pipelinePath,
              cron: cronParts.join(' '),
            }),
          };
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    return { result: toActionResult(err) };
  }
  return { result: { ok: false, message: raw } };
}
