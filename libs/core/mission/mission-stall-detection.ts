/**
 * MSAF-magentic-style stall detection for the mission task ledger
 * (ported concept from agent-framework _magentic.py: stall_count /
 * max_stall_count over rounds-without-progress).
 *
 * Kyberion adaptation: a non-terminal NEXT_TASKS task is the in-flight
 * unit; "progress" is a ledger event carrying its task_id. stall_count
 * counts ledger events since that task's last progress — the rounds
 * proxy. Read-only: returns advisory candidates, never mutates state.
 */

import * as nodePath from 'node:path';
import { loadJsonIfPresent, safeExistsSync, safeReadFile } from '../secure-io.js';
import {
  readMissionNextTasks,
  MISSION_TASK_CLOSED_STATUSES,
} from './mission-lifecycle-completion.js';

export interface MissionStallCandidate {
  task_id: string;
  status: string;
  last_progress_at?: string;
  stall_age_ms: number;
  /** Ledger events recorded since this task's last progress (rounds proxy). */
  stall_count: number;
}

export interface MissionStallReport {
  stall_threshold_ms: number;
  generated_at: string;
  /** True when execution-ledger.jsonl existed and was parsed. */
  ledger_seen: boolean;
  candidates: MissionStallCandidate[];
}

export const DEFAULT_STALL_THRESHOLD_MS = 4 * 60 * 60 * 1000;

interface LedgerEvent {
  ts: number;
  task_id?: string;
}

function readLedgerEvents(missionDir: string): LedgerEvent[] | null {
  const ledgerPath = nodePath.join(missionDir, 'execution-ledger.jsonl');
  if (!safeExistsSync(ledgerPath)) return null;
  const raw = safeReadFile(ledgerPath);
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const events: LedgerEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      const ts = Date.parse(String(entry.ts || entry.timestamp || ''));
      if (Number.isFinite(ts)) {
        events.push({
          ts,
          ...(entry.task_id ? { task_id: String(entry.task_id) } : {}),
        });
      }
    } catch {
      // Skip malformed ledger lines; detection stays advisory.
    }
  }
  return events;
}

export function detectMissionStalls(
  missionDir: string,
  options: { now?: number; stallThresholdMs?: number } = {}
): MissionStallReport {
  const now = options.now ?? Date.now();
  const threshold = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const generatedAt = new Date(now).toISOString();

  const tasksPath = nodePath.join(missionDir, 'NEXT_TASKS.json');
  let rawTasks: unknown;
  try {
    rawTasks = loadJsonIfPresent(tasksPath) ?? readMissionNextTasks(missionDir);
  } catch {
    rawTasks = undefined;
  }
  const tasks = Array.isArray(rawTasks)
    ? rawTasks.filter(
        (t): t is Record<string, unknown> =>
          Boolean(t) && typeof t === 'object' && !Array.isArray(t)
      )
    : [];
  const openTasks = tasks.filter(
    (t) => !MISSION_TASK_CLOSED_STATUSES.has(String(t.status || 'planned').toLowerCase())
  );

  const events = readLedgerEvents(missionDir);
  if (events === null || events.length === 0 || openTasks.length === 0) {
    return {
      stall_threshold_ms: threshold,
      generated_at: generatedAt,
      ledger_seen: events !== null,
      candidates: [],
    };
  }

  const firstEventTs = events[0].ts;
  const lastIndexByTask = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.task_id) lastIndexByTask.set(event.task_id, index);
  });

  const candidates: MissionStallCandidate[] = [];
  for (const task of openTasks) {
    const taskId = String(task.task_id || '').trim();
    if (!taskId) continue;
    const lastIndex = lastIndexByTask.get(taskId);
    const lastTs = lastIndex === undefined ? firstEventTs : events[lastIndex].ts;
    const stallAgeMs = now - lastTs;
    if (stallAgeMs < threshold) continue;
    candidates.push({
      task_id: taskId,
      status: String(task.status || 'planned'),
      ...(lastIndex !== undefined ? { last_progress_at: new Date(lastTs).toISOString() } : {}),
      stall_age_ms: stallAgeMs,
      stall_count: lastIndex === undefined ? events.length : events.length - 1 - lastIndex,
    });
  }
  candidates.sort((a, b) => b.stall_age_ms - a.stall_age_ms);

  return {
    stall_threshold_ms: threshold,
    generated_at: generatedAt,
    ledger_seen: true,
    candidates,
  };
}
