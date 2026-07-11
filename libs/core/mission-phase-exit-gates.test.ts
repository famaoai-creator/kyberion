import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateMissionPhaseExitGates,
  loadMissionPhaseGateDefinitions,
  resolvePhaseGateMode,
} from './mission-orchestration-worker.js';
import { missionDir } from './path-resolver.js';

// MO-02 Task 4: phase exit gates. Fixtures live under a unique throwaway
// mission id and are removed after each test.
describe('mission phase exit gates (MO-02)', () => {
  const missionId = `MSN-GATE-TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  let missionPath: string;
  const savedMode = process.env.KYBERION_PHASE_GATE_MODE;
  const savedRole = process.env.MISSION_ROLE;

  const writeGateDefinition = (id: string, gate: Record<string, unknown>, phase = 'execution') => {
    const defsDir = path.join(missionPath, 'gates', 'definitions');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(
      path.join(defsDir, `${id}.json`),
      JSON.stringify({ mission_id: missionId, phase, position: 'exit', gate }, null, 2)
    );
  };

  beforeEach(() => {
    // withExecutionContext restores env before awaited work runs (sync-only
    // contract) — mission tests set MISSION_ROLE directly instead.
    process.env.MISSION_ROLE = 'mission_controller';
    missionPath = missionDir(missionId, 'public');
    fs.mkdirSync(missionPath, { recursive: true });
    delete process.env.KYBERION_PHASE_GATE_MODE;
  });

  afterEach(() => {
    fs.rmSync(missionPath, { recursive: true, force: true });
    if (savedMode === undefined) delete process.env.KYBERION_PHASE_GATE_MODE;
    else process.env.KYBERION_PHASE_GATE_MODE = savedMode;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });

  it('defaults to warn mode and honors enforce/off', () => {
    expect(resolvePhaseGateMode()).toBe('warn');
    process.env.KYBERION_PHASE_GATE_MODE = 'enforce';
    expect(resolvePhaseGateMode()).toBe('enforce');
    process.env.KYBERION_PHASE_GATE_MODE = 'off';
    expect(resolvePhaseGateMode()).toBe('off');
  });

  it('loads persisted gate definitions and ignores malformed files', () => {
    writeGateDefinition('GATE_A', { id: 'GATE_A', checks: [] });
    fs.writeFileSync(
      path.join(missionPath, 'gates', 'definitions', 'broken.json'),
      'not valid json'
    );

    const definitions = loadMissionPhaseGateDefinitions(missionId);
    expect(definitions).toHaveLength(1);
    expect(definitions[0].gate.id).toBe('GATE_A');
    expect(definitions[0].position).toBe('exit');
  });

  it('passes when required evidence exists and records the evaluation', async () => {
    const evidencePath = path.join(missionPath, 'evidence', 'report.md');
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, '# done');
    writeGateDefinition('EXECUTION_DONE', {
      id: 'EXECUTION_DONE',
      checks: [{ kind: 'evidence_exists', params: { path: evidencePath } }],
    });

    const outcome = await evaluateMissionPhaseExitGates(missionId);
    expect(outcome.passed).toBe(true);
    expect(outcome.evaluated).toBe(1);
    const records = fs
      .readdirSync(path.join(missionPath, 'gates'))
      .filter((entry) => entry.endsWith('.json') && entry.startsWith('EXECUTION_DONE'));
    expect(records.length).toBeGreaterThan(0);
  });

  it('fails with reasons when evidence is missing and counts prior failures', async () => {
    writeGateDefinition('EXECUTION_DONE', {
      id: 'EXECUTION_DONE',
      checks: [
        {
          kind: 'evidence_exists',
          params: { path: path.join(missionPath, 'evidence', 'nope.md') },
        },
      ],
    });

    const first = await evaluateMissionPhaseExitGates(missionId);
    expect(first.passed).toBe(false);
    expect(first.failures[0].prior_failures).toBe(0);
    expect(first.failures[0].reasons.join(' ')).toContain('Missing evidence');

    const second = await evaluateMissionPhaseExitGates(missionId);
    expect(second.failures[0].prior_failures).toBe(1);
    const third = await evaluateMissionPhaseExitGates(missionId);
    // two prior failures reached — the worker treats this as the circuit-breaker threshold
    expect(third.failures[0].prior_failures).toBe(2);
  });

  it('resolves reviewer_approved checks from NEXT_TASKS.json outcomes', async () => {
    fs.writeFileSync(
      path.join(missionPath, 'NEXT_TASKS.json'),
      JSON.stringify([
        { task_id: 'review-1', status: 'completed' },
        { task_id: 'review-2', status: 'requested' },
      ])
    );
    writeGateDefinition('REVIEW_PASSED', {
      id: 'REVIEW_PASSED',
      checks: [{ kind: 'reviewer_approved', params: { task_id: 'review-1' } }],
    });
    writeGateDefinition('REVIEW_PENDING', {
      id: 'REVIEW_PENDING',
      checks: [{ kind: 'reviewer_approved', params: { task_id: 'review-2' } }],
    });

    const outcome = await evaluateMissionPhaseExitGates(missionId);
    expect(outcome.evaluated).toBe(2);
    expect(outcome.passed).toBe(false);
    const failedIds = outcome.failures.map((failure) => failure.gate_id);
    expect(failedIds).toEqual(['REVIEW_PENDING']);
    expect(outcome.failures[0].reasons.join(' ')).toContain('status: requested');
  });
});
