import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';

import {
  buildSoftwareQualityReport,
  createDefectCandidates,
  evaluateAcceptanceCriteria,
  evaluateDefinitionOfDone,
  evaluateDefinitionOfReady,
  evaluateQualityContract,
  evaluateTestTraceability,
  type SoftwareQualityContract,
  type TestInventory,
} from './software-quality.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';

function contract(): SoftwareQualityContract {
  return {
    version: '1.0.0',
    project_id: 'project-1',
    accountable_human_id: 'human:owner',
    must_have_requirement_ids: ['REQ-1'],
    dor: [
      {
        check_id: 'DOR-1',
        description: 'Scope and dependencies are agreed',
        status: 'passed',
        evidence_refs: ['evidence/scope.md'],
      },
    ],
    acceptance_criteria: [
      {
        criterion_id: 'AC-1',
        description: 'An unauthorized request is rejected with status 403',
        requirement_refs: ['REQ-1'],
        expected_result: 'The response status is 403 and no record is written.',
        status: 'passed',
        evidence_refs: ['evidence/ac-1.json'],
      },
    ],
    dod: [
      {
        check_id: 'DOD-1',
        description: 'Required regression suite passed',
        status: 'passed',
        evidence_refs: ['evidence/regression.json'],
      },
    ],
  };
}

function inventory(): TestInventory {
  return {
    version: '1.0.0',
    project_id: 'project-1',
    items: [
      {
        item_id: 'TEST-1',
        title: 'Reject unauthorized request',
        viewpoint_ids: ['security.authorization'],
        requirement_refs: ['REQ-1'],
        acceptance_criteria_refs: ['AC-1'],
        risk_refs: ['RISK-1'],
        risk_level: 'high',
        expected_result: '403 is returned without a write.',
        execution_mode: 'safe_auto',
      },
    ],
  };
}

describe('software quality lifecycle', () => {
  it('keeps all QA artifacts and the viewpoint catalog schema-valid', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const root = process.cwd();
    const cases = [
      ['software-quality-contract.schema.json', contract()],
      ['test-inventory.schema.json', inventory()],
      [
        'test-execution-record.schema.json',
        {
          version: '1.0.0',
          run_id: 'RUN-1',
          project_id: 'project-1',
          subject_ref: 'git:abc123',
          environment: 'test',
          executor: { resource_id: 'agent:tester', resource_type: 'ai_agent' },
          started_at: '2026-07-12T00:00:00.000Z',
          finished_at: '2026-07-12T00:01:00.000Z',
          results: [{ item_id: 'TEST-1', status: 'passed', evidence_refs: ['trace:1'] }],
        },
      ],
      [
        'defect-record.schema.json',
        {
          version: '1.0.0',
          defect_id: 'DEF-1',
          project_id: 'project-1',
          title: 'Unauthorized write succeeds',
          status: 'candidate',
          severity: 'critical',
          priority: 'p0',
          source_test_refs: ['TEST-1'],
          reproduction_steps: ['Send a request without credentials.'],
          expected_result: '403 is returned.',
          observed_result: 'A record is written.',
          created_at: '2026-07-12T00:01:00.000Z',
        },
      ],
      [
        'software-quality-report.schema.json',
        {
          version: '1.0.0',
          report_id: 'REPORT-1',
          project_id: 'project-1',
          subject_ref: 'git:abc123',
          generated_at: '2026-07-12T00:02:00.000Z',
          gate_status: { dor: 'pass', acceptance_criteria: 'pass', dod: 'pass' },
          coverage: { required: 1, covered: 1 },
          execution: { planned: 1, passed: 1 },
          defects: { open: 0 },
          residual_risks: [],
          waiver_refs: [],
          recommendation: 'go',
          evidence_refs: ['run:RUN-1'],
          accountable_human_id: 'human:owner',
          human_decision: 'pending',
        },
      ],
    ] as const;
    for (const [schemaName, value] of cases) {
      const validate = compileSchemaFromPath(
        ajv,
        path.join(root, 'knowledge/product/schemas', schemaName)
      );
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    }

    const viewpoints = JSON.parse(
      safeReadFile('knowledge/product/governance/software-test-viewpoints.json', {
        encoding: 'utf8',
      }) as string
    );
    const validateViewpoints = compileSchemaFromPath(
      ajv,
      path.join(root, 'knowledge/product/schemas/software-test-viewpoints.schema.json')
    );
    expect(validateViewpoints(viewpoints), JSON.stringify(validateViewpoints.errors)).toBe(true);
    expect(viewpoints.viewpoints).toHaveLength(10);
  });

  it('passes a traceable contract through DoR, AC, and DoD', () => {
    const value = contract();
    expect(evaluateQualityContract(value).passed).toBe(true);
    expect(evaluateDefinitionOfReady(value).passed).toBe(true);
    expect(evaluateAcceptanceCriteria(value).passed).toBe(true);
    expect(evaluateDefinitionOfDone(value).passed).toBe(true);
  });

  it('rejects ambiguous or unobservable acceptance criteria', () => {
    const value = contract();
    value.acceptance_criteria[0] = {
      ...value.acceptance_criteria[0],
      description: '適切に動作する',
      expected_result: '',
    };
    const result = evaluateQualityContract(value);
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('ambiguous');
    expect(result.reasons.join(' ')).toContain('observable expected result');
  });

  it('fails closed when a passed check has no evidence', () => {
    const value = contract();
    value.dor[0].evidence_refs = [];
    value.acceptance_criteria[0].evidence_refs = [];
    value.dod[0].evidence_refs = [];
    expect(evaluateDefinitionOfReady(value).passed).toBe(false);
    expect(evaluateAcceptanceCriteria(value).passed).toBe(false);
    expect(evaluateDefinitionOfDone(value).passed).toBe(false);
  });

  it('accepts only active, accountable waivers with compensating controls', () => {
    const value = contract();
    value.dod[0].status = 'failed';
    value.waivers = [
      {
        waiver_id: 'W-1',
        check_refs: ['DOD-1'],
        reason: 'External test environment is temporarily unavailable.',
        accountable_human_id: 'human:owner',
        expires_at: '2030-01-01T00:00:00.000Z',
        compensating_controls: ['Canary deployment is disabled.'],
        residual_risk: 'Regression may remain undetected.',
      },
    ];
    expect(evaluateDefinitionOfDone(value, new Date('2029-01-01T00:00:00.000Z')).passed).toBe(true);
    expect(evaluateDefinitionOfDone(value, new Date('2031-01-01T00:00:00.000Z')).passed).toBe(
      false
    );
  });

  it('detects missing requirement, acceptance, risk, and viewpoint coverage', () => {
    const value = inventory();
    value.items[0].requirement_refs = [];
    value.items[0].acceptance_criteria_refs = [];
    value.items[0].risk_refs = [];
    value.items[0].viewpoint_ids = [];
    const result = evaluateTestTraceability({
      contract: contract(),
      inventory: value,
      requiredRiskRefs: ['RISK-1'],
    });
    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(4);
  });

  it('requires an omission rationale for prohibited tests', () => {
    const value = inventory();
    value.items[0].execution_mode = 'prohibited';
    const result = evaluateTestTraceability({ contract: contract(), inventory: value });
    expect(result.reasons.join(' ')).toContain('omission reason');
  });

  it('creates defect candidates without granting AI release approval', () => {
    const execution = {
      run_id: 'RUN-1',
      subject_ref: 'git:abc123',
      results: [
        {
          item_id: 'TEST-1',
          status: 'failed' as const,
          evidence_refs: ['trace:1'],
          observed_result: 'A record was written.',
        },
      ],
    };
    const defects = createDefectCandidates({ inventory: inventory(), execution });
    expect(defects).toMatchObject([
      { defect_id: 'DEF-RUN-1-TEST-1', status: 'candidate', severity: 'major' },
    ]);
    const report = buildSoftwareQualityReport({
      contract: contract(),
      inventory: inventory(),
      execution,
      requiredRiskRefs: ['RISK-1'],
    });
    expect(report.recommendation).toBe('no_go');
    expect(report.human_decision).toBe('pending');
    expect(report.accountable_human_id).toBe('human:owner');
  });

  it('reports insufficient evidence before considering pass rates', () => {
    const value = inventory();
    value.items.push({
      ...value.items[0],
      item_id: 'TEST-2',
      title: 'Unexecuted regression case',
    });
    const report = buildSoftwareQualityReport({
      contract: contract(),
      inventory: value,
      execution: {
        run_id: 'RUN-2',
        subject_ref: 'git:abc123',
        results: [{ item_id: 'TEST-1', status: 'passed', evidence_refs: [] }],
      },
      requiredRiskRefs: ['RISK-1'],
    });
    expect(report.recommendation).toBe('insufficient_evidence');
    expect(report.recommendation_reasons.join(' ')).toContain('lack evidence');
    expect(report.recommendation_reasons.join(' ')).toContain('not executed');
  });

  it('recommends go only when gates, traceability, execution, and evidence pass', () => {
    const report = buildSoftwareQualityReport({
      contract: contract(),
      inventory: inventory(),
      execution: {
        run_id: 'RUN-3',
        subject_ref: 'git:abc123',
        results: [{ item_id: 'TEST-1', status: 'passed', evidence_refs: ['trace:3'] }],
      },
      requiredRiskRefs: ['RISK-1'],
    });
    expect(report.recommendation).toBe('go');
    expect(report.human_decision).toBe('pending');
  });
});
