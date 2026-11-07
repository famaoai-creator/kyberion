import { describe, expect, it } from 'vitest';

import {
  buildSoftwareQualityReport,
  evaluateDefinitionOfDone,
  evaluateDefinitionOfReady,
  evaluateTestTraceability,
  type SoftwareQualityContract,
  type TestExecutionRecord,
  type TestInventory,
} from './software-quality.js';
import { evaluateQualityEnforcement } from './software-quality-operations.js';

function contract(): SoftwareQualityContract {
  return {
    version: '1.0.0',
    project_id: 'e2e-project',
    accountable_human_id: 'human:owner',
    must_have_requirement_ids: ['REQ-1'],
    dor: [{ check_id: 'DOR-1', description: 'Ready', status: 'passed', evidence_refs: ['e:dor'] }],
    acceptance_criteria: [
      {
        criterion_id: 'AC-1',
        description: 'Returns 200',
        requirement_refs: ['REQ-1'],
        expected_result: '200',
        status: 'passed',
        evidence_refs: ['e:ac'],
      },
    ],
    dod: [
      {
        check_id: 'DOD-1',
        description: 'Regression passed',
        status: 'passed',
        evidence_refs: ['e:dod'],
      },
    ],
  };
}

function inventory(): TestInventory {
  return {
    version: '2.0.0',
    project_id: 'e2e-project',
    items: [
      {
        item_id: 'TEST-1',
        title: 'Request',
        viewpoint_ids: ['functional.business-rules'],
        requirement_refs: ['REQ-1'],
        acceptance_criteria_refs: ['AC-1'],
        risk_refs: ['RISK-1'],
        risk_level: 'high',
        expected_result: '200',
        execution_mode: 'safe_auto',
      },
    ],
  };
}

function execution(status: 'passed' | 'failed' = 'passed'): TestExecutionRecord {
  return {
    run_id: 'RUN-E2E',
    subject_ref: 'git:e2e',
    results: [{ item_id: 'TEST-1', status, evidence_refs: ['trace:e2e'], observed_result: status }],
  };
}

describe('software quality lifecycle E2E scenarios', () => {
  it('1: completes the happy path while retaining human release responsibility', () => {
    const report = buildSoftwareQualityReport({
      contract: contract(),
      inventory: inventory(),
      execution: execution(),
      requiredRiskRefs: ['RISK-1'],
    });
    expect(report).toMatchObject({ recommendation: 'go', human_decision: 'pending' });
    expect(evaluateQualityEnforcement({ report, mode: 'enforce' }).allowed).toBe(true);
  });

  it('2: blocks work when DoR is incomplete', () => {
    const value = contract();
    value.dor[0].status = 'pending';
    value.dor[0].evidence_refs = [];
    expect(evaluateDefinitionOfReady(value).passed).toBe(false);
  });

  it('3: detects an uncovered acceptance criterion', () => {
    const value = inventory();
    value.items[0].acceptance_criteria_refs = [];
    const result = evaluateTestTraceability({
      contract: contract(),
      inventory: value,
      requiredRiskRefs: ['RISK-1'],
    });
    expect(result.reasons.join(' ')).toContain('AC-1');
  });

  it('4: changes the recommendation after a failed test is fixed and retested', () => {
    const failed = buildSoftwareQualityReport({
      contract: contract(),
      inventory: inventory(),
      execution: execution('failed'),
      requiredRiskRefs: ['RISK-1'],
    });
    const retested = buildSoftwareQualityReport({
      contract: contract(),
      inventory: inventory(),
      execution: execution('passed'),
      requiredRiskRefs: ['RISK-1'],
    });
    expect(failed.recommendation).toBe('no_go');
    expect(retested.recommendation).toBe('go');
  });

  it('5: blocks release while a critical defect remains', () => {
    const report = buildSoftwareQualityReport({
      contract: contract(),
      inventory: inventory(),
      execution: execution('failed'),
      requiredRiskRefs: ['RISK-1'],
    });
    expect(report.defects.major).toBe(1);
    expect(evaluateQualityEnforcement({ report, mode: 'enforce' })).toMatchObject({
      allowed: false,
      severity: 'blocking',
    });
  });

  it('6: permits a time-bounded human waiver but rejects it after expiry', () => {
    const value = contract();
    value.dod[0].status = 'failed';
    value.waivers = [
      {
        waiver_id: 'W-1',
        check_refs: ['DOD-1'],
        reason: 'Environment unavailable',
        accountable_human_id: 'human:owner',
        expires_at: '2026-08-01T00:00:00.000Z',
        compensating_controls: ['Release disabled'],
        residual_risk: 'Regression not executed',
      },
    ];
    expect(evaluateDefinitionOfDone(value, new Date('2026-07-12T00:00:00.000Z')).passed).toBe(true);
    expect(evaluateDefinitionOfDone(value, new Date('2026-08-02T00:00:00.000Z')).passed).toBe(
      false
    );
  });
});
