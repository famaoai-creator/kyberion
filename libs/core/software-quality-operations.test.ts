import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { registerReasoningBackend, resetReasoningBackend } from './reasoning-backend.js';
import { safeRmSync } from './secure-io.js';
import type { SoftwareQualityContract, TestInventory } from './software-quality.js';
import {
  compileTestInventoryToAdf,
  defectCurrentStatus,
  deriveTestInventory,
  dispatchTestInventory,
  evaluateQualityEnforcement,
  recordDefectCandidate,
  transitionDefect,
} from './software-quality-operations.js';

const defectPath = pathResolver.sharedTmp('software-quality-operations/defects.jsonl');

afterEach(() => {
  resetReasoningBackend();
  safeRmSync(pathResolver.sharedTmp('software-quality-operations'), {
    recursive: true,
    force: true,
  });
});

function contract(): SoftwareQualityContract {
  return {
    version: '1.0.0',
    project_id: 'project-1',
    accountable_human_id: 'human:owner',
    must_have_requirement_ids: ['REQ-1'],
    dor: [{ check_id: 'DOR-1', description: 'Ready', status: 'pending' }],
    acceptance_criteria: [
      {
        criterion_id: 'AC-1',
        description: 'Returns 200',
        requirement_refs: ['REQ-1'],
        expected_result: '200',
        status: 'pending',
      },
    ],
    dod: [{ check_id: 'DOD-1', description: 'Done', status: 'pending' }],
  };
}

describe('software quality operations', () => {
  it('derives deterministic viewpoints with a stub backend', async () => {
    const result = await deriveTestInventory({
      contract: contract(),
      systemTags: ['ui', 'api', 'ai'],
      riskRefs: ['RISK-1'],
    });
    expect(result.items.length).toBeGreaterThanOrEqual(6);
    expect(result.items.flatMap((item) => item.viewpoint_ids)).toContain('security.trust-boundary');
    expect(result.items.every((item) => item.requirement_refs?.includes('REQ-1'))).toBe(true);
  });

  it('keeps deterministic items and adds only novel reasoning viewpoints', async () => {
    registerReasoningBackend({
      name: 'fake',
      prompt: async () =>
        JSON.stringify({
          items: [
            {
              item_id: 'LLM-1',
              title: 'Novel compliance check',
              viewpoint_ids: ['compliance.retention'],
              requirement_refs: ['REQ-1'],
              acceptance_criteria_refs: ['AC-1'],
              risk_refs: ['RISK-1'],
              risk_level: 'high',
              expected_result: 'Retention policy is enforced.',
              execution_mode: 'manual_only',
            },
            {
              item_id: 'LLM-DUP',
              title: 'Duplicate security check',
              viewpoint_ids: ['security.trust-boundary'],
              risk_level: 'high',
              expected_result: 'Duplicate',
              execution_mode: 'safe_auto',
            },
          ],
        }),
    } as never);
    const result = await deriveTestInventory({
      contract: contract(),
      systemTags: ['api'],
      riskRefs: ['RISK-1'],
    });
    expect(result.items.flatMap((item) => item.viewpoint_ids)).toContain('compliance.retention');
    expect(
      result.items.filter((item) => item.viewpoint_ids.includes('security.trust-boundary'))
    ).toHaveLength(1);
  });

  it('dispatches safe tests and separates approval, manual, and prohibited work', async () => {
    const inventory: TestInventory = {
      version: '2.0.0',
      project_id: 'project-1',
      items: [
        {
          item_id: 'SAFE',
          title: 'API contract',
          viewpoint_ids: ['contract.integration'],
          risk_level: 'medium',
          expected_result: 'Contract passes.',
          execution_mode: 'safe_auto',
        },
        {
          item_id: 'APPROVE',
          title: 'Security probe',
          viewpoint_ids: ['security.trust-boundary'],
          risk_level: 'critical',
          expected_result: 'Probe is contained.',
          execution_mode: 'approval_required',
        },
        {
          item_id: 'MANUAL',
          title: 'Exploratory review',
          viewpoint_ids: ['ux.accessibility-recovery'],
          risk_level: 'low',
          expected_result: 'Operator records observations.',
          execution_mode: 'manual_only',
        },
        {
          item_id: 'DENIED',
          title: 'Production destruction',
          viewpoint_ids: ['operations.deploy-recover'],
          risk_level: 'critical',
          expected_result: 'Never executed.',
          execution_mode: 'prohibited',
          omission_reason: 'Destructive production operation.',
        },
      ],
    };
    const results = await dispatchTestInventory({
      inventory,
      executors: {
        network: async () => ({ status: 'passed', evidence_refs: ['trace:network'] }),
      },
      requestApproval: (item) => `APPROVAL-${item.item_id}`,
    });
    expect(results.map((result) => result.status)).toEqual([
      'passed',
      'awaiting_approval',
      'manual_required',
      'prohibited',
    ]);
    expect(results[1].approval_request_id).toBe('APPROVAL-APPROVE');
  });

  it('compiles only governed safe-auto actuator steps into ADF', () => {
    const inventory: TestInventory = {
      version: '2.0.0',
      project_id: 'project-1',
      items: [
        {
          item_id: 'SAFE-1',
          title: 'Run unit test',
          viewpoint_ids: ['functional.business-rules'],
          risk_level: 'medium',
          expected_result: 'Tests pass.',
          execution_mode: 'safe_auto',
          automation: {
            actuator: 'code',
            op: 'run_tests',
            params: { target: 'libs/core/software-quality.test.ts' },
          },
        },
        {
          item_id: 'APPROVAL-1',
          title: 'Production security probe',
          viewpoint_ids: ['security.trust-boundary'],
          risk_level: 'critical',
          expected_result: 'Probe is contained.',
          execution_mode: 'approval_required',
          automation: {
            actuator: 'network',
            op: 'request',
            params: { url: 'https://example.test' },
          },
        },
        {
          item_id: 'NO-AUTOMATION',
          title: 'Missing automation',
          viewpoint_ids: ['change.regression'],
          risk_level: 'low',
          expected_result: 'Reviewed.',
          execution_mode: 'safe_auto',
        },
      ],
    };
    const compiled = compileTestInventoryToAdf({ inventory });
    expect(compiled.steps).toEqual([
      {
        id: 'qa_safe_1',
        role: 'transform',
        op: 'code:run_tests',
        params: {
          target: 'libs/core/software-quality.test.ts',
          qa_item_id: 'SAFE-1',
          expected_result: 'Tests pass.',
        },
      },
    ]);
    expect(compiled.deferred.map((item) => item.item_id)).toEqual(['APPROVAL-1', 'NO-AUTOMATION']);
  });

  it('persists governed defect transitions and reserves risk acceptance for humans', () => {
    recordDefectCandidate(
      {
        defect_id: 'DEF-1',
        source_test_refs: ['TEST-1'],
        title: 'Failure',
        status: 'candidate',
        severity: 'major',
        expected_result: 'pass',
        observed_result: 'fail',
        evidence_refs: ['trace:1'],
      },
      'agent:tester',
      defectPath
    );
    transitionDefect({
      defectId: 'DEF-1',
      to: 'open',
      actorId: 'agent:tester',
      actorType: 'ai_agent',
      reason: 'Reproduced',
      filePath: defectPath,
    });
    expect(() =>
      transitionDefect({
        defectId: 'DEF-1',
        to: 'accepted_risk',
        actorId: 'agent:tester',
        actorType: 'ai_agent',
        reason: 'Accept',
        filePath: defectPath,
      })
    ).toThrow('Only a human');
    transitionDefect({
      defectId: 'DEF-1',
      to: 'accepted_risk',
      actorId: 'human:owner',
      actorType: 'human',
      reason: 'Accepted until next release',
      filePath: defectPath,
    });
    expect(defectCurrentStatus('DEF-1', defectPath)).toBe('accepted_risk');
  });

  it('graduates enforcement from report-only through warn to blocking', () => {
    const report = {
      gate_status: {
        dor: 'fail' as const,
        acceptance_criteria: 'fail' as const,
        dod: 'fail' as const,
      },
      coverage: {},
      execution: {},
      defects: { candidates: 1 },
      residual_risks: ['One defect remains.'],
      recommendation: 'no_go' as const,
      recommendation_reasons: ['One defect remains.'],
      evidence_refs: ['trace:1'],
      accountable_human_id: 'human:owner',
      human_decision: 'pending' as const,
    };
    expect(evaluateQualityEnforcement({ report, mode: 'report-only' }).allowed).toBe(true);
    expect(evaluateQualityEnforcement({ report, mode: 'warn' })).toMatchObject({
      allowed: true,
      severity: 'warning',
    });
    expect(evaluateQualityEnforcement({ report, mode: 'enforce' })).toMatchObject({
      allowed: false,
      severity: 'blocking',
    });
  });
});
