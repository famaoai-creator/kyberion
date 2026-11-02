import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { detectMissionStalls } from './mission-stall-detection.js';

const missionId = 'MSN-STALL-TEST';
const missionPath = pathResolver.missionDir(missionId, 'public');

const NOW = Date.parse('2026-11-02T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function iso(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString();
}

function prepare(
  tasks: Array<Record<string, unknown>>,
  ledger: Array<Record<string, unknown>> | null
) {
  safeMkdir(missionPath, { recursive: true });
  safeWriteFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), JSON.stringify(tasks, null, 2));
  if (ledger) {
    safeWriteFile(
      nodePath.join(missionPath, 'execution-ledger.jsonl'),
      ledger.map((e) => JSON.stringify(e)).join('\n') + '\n'
    );
  }
}

let previousMissionRole: string | undefined;
let previousPersona: string | undefined;

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_PERSONA;
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'stall-test-actor';
  safeRmSync(missionPath, { recursive: true, force: true });
});

afterEach(() => {
  safeRmSync(missionPath, { recursive: true, force: true });
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
});

describe('detectMissionStalls', () => {
  it('flags open tasks whose last progress exceeds the threshold', () => {
    prepare(
      [
        { task_id: 'old', status: 'in_progress' },
        { task_id: 'fresh', status: 'in_progress' },
      ],
      [
        { ts: iso(10 * HOUR), event_type: 'evidence_recorded', task_id: 'old' },
        { ts: iso(30 * 60 * 1000), event_type: 'evidence_recorded', task_id: 'fresh' },
      ]
    );
    const report = detectMissionStalls(missionPath, { now: NOW, stallThresholdMs: 4 * HOUR });
    expect(report.ledger_seen).toBe(true);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].task_id).toBe('old');
    expect(report.candidates[0].stall_age_ms).toBe(10 * HOUR);
    expect(report.candidates[0].last_progress_at).toBe(iso(10 * HOUR));
    // One ledger event (the fresh task's) landed after old's last progress.
    expect(report.candidates[0].stall_count).toBe(1);
  });

  it('excludes closed tasks even when stale', () => {
    prepare(
      [{ task_id: 'done', status: 'completed' }],
      [{ ts: iso(20 * HOUR), event_type: 'evidence_recorded', task_id: 'done' }]
    );
    const report = detectMissionStalls(missionPath, { now: NOW, stallThresholdMs: 4 * HOUR });
    expect(report.candidates).toHaveLength(0);
  });

  it('treats tasks with no ledger events as stalled since mission start', () => {
    prepare(
      [{ task_id: 'silent', status: 'planned' }],
      [{ ts: iso(6 * HOUR), event_type: 'MISSION_CREATE' }]
    );
    const report = detectMissionStalls(missionPath, { now: NOW, stallThresholdMs: 4 * HOUR });
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].task_id).toBe('silent');
    expect(report.candidates[0].last_progress_at).toBeUndefined();
    expect(report.candidates[0].stall_count).toBe(1);
  });

  it('returns no candidates when the ledger is missing', () => {
    prepare([{ task_id: 'x', status: 'in_progress' }], null);
    const report = detectMissionStalls(missionPath, { now: NOW });
    expect(report.ledger_seen).toBe(false);
    expect(report.candidates).toHaveLength(0);
  });

  it('respects the threshold boundary', () => {
    prepare(
      [{ task_id: 'edge', status: 'in_progress' }],
      [{ ts: iso(4 * HOUR), event_type: 'evidence_recorded', task_id: 'edge' }]
    );
    const report = detectMissionStalls(missionPath, { now: NOW, stallThresholdMs: 4 * HOUR });
    expect(report.candidates).toHaveLength(1);
  });

  it('reports empty when there are no open tasks', () => {
    prepare([], [{ ts: iso(HOUR), event_type: 'MISSION_CREATE' }]);
    const report = detectMissionStalls(missionPath, { now: NOW });
    expect(report.candidates).toHaveLength(0);
  });
});
