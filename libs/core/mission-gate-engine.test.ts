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

  it('llm_review verdicts follow the backend and fail closed on stub', async () => {
    const { registerReasoningBackend, resetReasoningBackend } =
      await import('./reasoning-backend.js');
    safeMkdir(`${missionPath}/evidence`, { recursive: true });
    safeWriteFile(`${missionPath}/evidence/report.md`, '# 提案\n結論と根拠が揃った文書。');
    const gateDef = {
      id: 'llm-gate',
      checks: [
        {
          kind: 'llm_review' as const,
          params: { path: `${missionPath}/evidence/report.md`, criteria: ['根拠がある'] },
        },
      ],
    };

    resetReasoningBackend();
    const stubGate = await evaluateMissionGate({
      missionId,
      gate: gateDef,
      evidenceDir: `${missionPath}/gates`,
    });
    expect(stubGate.verdict).toBe('fail');
    expect(stubGate.reasons.join(' ')).toContain('real reasoning backend');

    registerReasoningBackend({
      name: 'fake-llm',
      prompt: async () => '{"pass": true, "reasons": ["根拠と結論が対応"]}',
    } as never);
    const passGate = await evaluateMissionGate({
      missionId,
      gate: gateDef,
      evidenceDir: `${missionPath}/gates`,
    });
    expect(passGate.verdict).toBe('pass');

    registerReasoningBackend({
      name: 'fake-llm',
      prompt: async () =>
        '{"pass": false, "reasons": ["結論に根拠がない"], "improvements": ["出典を追加"]}',
    } as never);
    const failGate = await evaluateMissionGate({
      missionId,
      gate: gateDef,
      evidenceDir: `${missionPath}/gates`,
    });
    expect(failGate.verdict).toBe('fail');
    expect(failGate.reasons.join(' ')).toContain('結論に根拠がない');
    resetReasoningBackend();
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

  it('evaluates software quality lifecycle and traceability checks', async () => {
    const contract = {
      version: '1.0.0',
      project_id: 'project-1',
      accountable_human_id: 'human:owner',
      must_have_requirement_ids: ['REQ-1'],
      dor: [
        {
          check_id: 'DOR-1',
          description: 'Scope is ready',
          status: 'passed',
          evidence_refs: ['evidence/scope.md'],
        },
      ],
      acceptance_criteria: [
        {
          criterion_id: 'AC-1',
          description: 'Unauthorized requests return 403',
          requirement_refs: ['REQ-1'],
          expected_result: '403 is returned without a write.',
          status: 'passed',
          evidence_refs: ['evidence/ac-1.json'],
        },
      ],
      dod: [
        {
          check_id: 'DOD-1',
          description: 'Regression passed',
          status: 'passed',
          evidence_refs: ['evidence/regression.json'],
        },
      ],
    };
    const inventory = {
      version: '1.0.0',
      project_id: 'project-1',
      items: [
        {
          item_id: 'TEST-1',
          title: 'Authorization rejection',
          viewpoint_ids: ['security.authorization'],
          requirement_refs: ['REQ-1'],
          acceptance_criteria_refs: ['AC-1'],
          risk_refs: ['RISK-1'],
          risk_level: 'high',
          expected_result: '403 is returned.',
          execution_mode: 'safe_auto',
        },
      ],
    };

    const gate = await evaluateMissionGate({
      missionId,
      gate: {
        id: 'software-quality-gate',
        checks: [
          { kind: 'quality_contract_valid', params: { contract } },
          { kind: 'dor_satisfied', params: { contract } },
          { kind: 'acceptance_criteria_verified', params: { contract } },
          { kind: 'dod_satisfied', params: { contract } },
          {
            kind: 'test_traceability',
            params: { contract, inventory, required_risk_refs: ['RISK-1'] },
          },
        ],
      },
      evidenceDir: `${missionPath}/gates`,
    });

    expect(gate.verdict).toBe('pass');
    expect(gate.checks).toHaveLength(5);
  });

  it('fails the QA gate when acceptance criteria lack evidence or coverage', async () => {
    const contract = {
      version: '1.0.0',
      project_id: 'project-1',
      accountable_human_id: 'human:owner',
      dor: [],
      acceptance_criteria: [
        {
          criterion_id: 'AC-1',
          description: 'A request returns status 200',
          requirement_refs: ['REQ-1'],
          expected_result: 'The response status is 200.',
          status: 'passed',
          evidence_refs: [],
        },
      ],
      dod: [],
    };
    const gate = await evaluateMissionGate({
      missionId,
      gate: {
        id: 'failing-software-quality-gate',
        checks: [
          { kind: 'acceptance_criteria_verified', params: { contract } },
          {
            kind: 'test_traceability',
            params: {
              contract,
              inventory: { version: '1.0.0', project_id: 'project-1', items: [] },
            },
          },
        ],
      },
    });

    expect(gate.verdict).toBe('fail');
    expect(gate.reasons.join(' ')).toContain('without evidence');
    expect(gate.reasons.join(' ')).toContain('not covered');
  });

  it('enforces a no-go quality report only in enforce mode', async () => {
    const report = {
      gate_status: { dor: 'pass', acceptance_criteria: 'fail', dod: 'fail' },
      coverage: { required: 2, covered: 1 },
      execution: { planned: 2, failed: 1 },
      defects: { candidates: 1 },
      residual_risks: ['A critical test failed.'],
      recommendation: 'no_go',
      recommendation_reasons: ['A critical test failed.'],
      evidence_refs: ['trace:1'],
      accountable_human_id: 'human:owner',
      human_decision: 'pending',
    };
    const warn = await evaluateMissionGate({
      missionId,
      gate: {
        id: 'quality-warn',
        checks: [{ kind: 'quality_release_allowed', params: { report, mode: 'warn' } }],
      },
    });
    const enforce = await evaluateMissionGate({
      missionId,
      gate: {
        id: 'quality-enforce',
        checks: [{ kind: 'quality_release_allowed', params: { report, mode: 'enforce' } }],
      },
    });
    expect(warn.verdict).toBe('pass');
    expect(warn.checks[0].reason).toContain('Quality warning');
    expect(enforce.verdict).toBe('fail');
    expect(enforce.reasons.join(' ')).toContain('blocked release');
  });
});
