import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import { evaluateMissionGate, recordMissionGateOverride } from './mission-gate-engine.js';

const missionId = 'MSN-GATE-ENGINE-001';
const missionPath = pathResolver.rootResolve(`active/shared/tmp/mission-gate-engine/${missionId}`);

afterEach(() => {
  safeRmSync(missionPath, { recursive: true, force: true });
});

describe('mission-gate-engine', () => {
  it('evaluates evidence, schema, reviewer, and command checks', async () => {
    safeMkdir(`${missionPath}/evidence`, { recursive: true });
    safeWriteFile(`${missionPath}/evidence/result.md`, '# result');

    const gate = await evaluateMissionGate({
      missionId,
      gate: {
        id: 'sample-gate',
        title: 'Sample gate',
        checks: [
          { kind: 'evidence_exists', params: { paths: [`${missionPath}/evidence/result.md`] } },
          {
            kind: 'schema_valid',
            params: {
              schema: 'task_result',
              value: {
                summary: 'ok',
                artifacts: [],
                verification_done: [],
                gaps: [],
                needs: [],
              },
            },
          },
          { kind: 'reviewer_approved', params: { approved: true, reason: 'looks good' } },
          {
            kind: 'command_succeeds',
            params: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
          },
        ],
      },
      evidenceDir: `${missionPath}/gates`,
    });

    expect(gate.verdict).toBe('pass');
    expect(gate.reasons).toEqual([]);
    expect(gate.evidence_path).toContain(`${missionPath}/gates`);
  });

  it('fails when any check fails', async () => {
    const gate = await evaluateMissionGate({
      missionId,
      gate: {
        id: 'failing-gate',
        checks: [
          { kind: 'evidence_exists', params: { paths: [`${missionPath}/evidence/missing.md`] } },
          { kind: 'human_override', params: { allow: false, reason: 'override denied' } },
        ],
      },
      evidenceDir: `${missionPath}/gates`,
    });

    expect(gate.verdict).toBe('fail');
    expect(gate.reasons.join(' ')).toContain('Missing evidence');
    expect(gate.reasons.join(' ')).toContain('override denied');
  });

  it('passes deliverable_quality when the deck brief meets the rubric threshold', async () => {
    safeMkdir(`${missionPath}/evidence`, { recursive: true });
    safeWriteFile(
      `${missionPath}/evidence/deck-brief.json`,
      JSON.stringify({
        kind: 'proposal-brief',
        slides: [
          { id: 's1', title: 'Hero' },
          { id: 's2', title: 'Summary' },
          { id: 's3', title: 'Problem' },
          { id: 's4', title: 'Solution' },
        ],
      })
    );

    const gate = await evaluateMissionGate({
      missionId,
      gate: {
        id: 'deck-quality-gate',
        checks: [
          {
            kind: 'deliverable_quality',
            params: {
              path: `${missionPath}/evidence/deck-brief.json`,
              kind: 'deck',
              min_score: 0.7,
            },
          },
        ],
      },
      evidenceDir: `${missionPath}/gates`,
    });

    expect(gate.verdict).toBe('pass');
  });

  it('fails deliverable_quality for a missing or poor deliverable', async () => {
    safeMkdir(`${missionPath}/evidence`, { recursive: true });
    safeWriteFile(
      `${missionPath}/evidence/empty-brief.json`,
      JSON.stringify({ kind: 'proposal-brief', slides: [] })
    );

    const gate = await evaluateMissionGate({
      missionId,
      gate: {
        id: 'deck-quality-gate',
        checks: [
          {
            kind: 'deliverable_quality',
            params: {
              path: `${missionPath}/evidence/empty-brief.json`,
              kind: 'deck',
              min_score: 0.7,
            },
          },
          {
            kind: 'deliverable_quality',
            params: { path: `${missionPath}/evidence/nonexistent.json`, kind: 'deck' },
          },
        ],
      },
      evidenceDir: `${missionPath}/gates`,
    });

    expect(gate.verdict).toBe('fail');
    expect(gate.reasons.join(' ')).toContain('quality');
    expect(gate.reasons.join(' ')).toContain('Deliverable not found');
  });

  it('records manual overrides as gate records', () => {
    const recordPath = recordMissionGateOverride({
      missionId,
      gateId: 'manual-review',
      outcome: 'passed',
      note: 'operator approved after review',
      actorId: 'operator',
      evidenceDir: `${missionPath}/gates`,
    });

    expect(recordPath).toContain(`${missionPath}/gates/manual-review-override-`);
    const raw = safeReadFile(recordPath, { encoding: 'utf8' }) as string;
    const record = JSON.parse(raw);
    expect(record).toMatchObject({
      mission_id: missionId,
      gate_id: 'manual-review-override',
      verdict: 'pass',
      override: true,
      override_outcome: 'passed',
      note: 'operator approved after review',
      confirmed_by: 'operator',
      source_gate_id: 'manual-review',
    });
  });
});
