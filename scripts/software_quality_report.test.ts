import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import { generateSoftwareQualityArtifacts } from './software_quality_report.js';

const root = pathResolver.rootResolve('active/shared/tmp/software-quality-report-test');

afterEach(() => safeRmSync(root, { recursive: true, force: true }));

function write(name: string, value: unknown): string {
  safeMkdir(root, { recursive: true });
  const file = `${root}/${name}`;
  safeWriteFile(file, JSON.stringify(value));
  return file;
}

describe('software quality report CLI core', () => {
  it('writes a no-go report and defect candidates from failed execution', () => {
    const contractPath = write('contract.json', {
      version: '1.0.0',
      project_id: 'project-1',
      accountable_human_id: 'human:owner',
      must_have_requirement_ids: ['REQ-1'],
      dor: [
        { check_id: 'DOR-1', description: 'Ready', status: 'passed', evidence_refs: ['e:dor'] },
      ],
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
          description: 'Regression',
          status: 'passed',
          evidence_refs: ['e:dod'],
        },
      ],
    });
    const inventoryPath = write('inventory.json', {
      version: '1.0.0',
      project_id: 'project-1',
      items: [
        {
          item_id: 'TEST-1',
          title: 'Request',
          viewpoint_ids: ['functional.business-rules'],
          requirement_refs: ['REQ-1'],
          acceptance_criteria_refs: ['AC-1'],
          risk_refs: ['RISK-1'],
          risk_level: 'critical',
          expected_result: '200',
          execution_mode: 'safe_auto',
        },
      ],
    });
    const executionPath = write('execution.json', {
      run_id: 'RUN-1',
      subject_ref: 'git:abc',
      results: [
        { item_id: 'TEST-1', status: 'failed', evidence_refs: ['trace:1'], observed_result: '500' },
      ],
    });
    const outputPath = `${root}/quality-report.json`;
    const publishSummaryPath = `${root}/latest-quality-report.json`;
    const result = generateSoftwareQualityArtifacts({
      contractPath,
      inventoryPath,
      executionPath,
      outputPath,
      publishSummaryPath,
      requiredRiskRefs: ['RISK-1'],
      now: new Date('2026-07-12T00:00:00.000Z'),
    });
    expect(result.recommendation).toBe('no_go');
    expect(result.defectCount).toBe(1);
    const report = JSON.parse(safeReadFile(outputPath, { encoding: 'utf8' }) as string);
    expect(report).toMatchObject({
      report_id: 'QUALITY-RUN-1',
      human_decision: 'pending',
      recommendation: 'no_go',
    });
    expect(JSON.parse(safeReadFile(publishSummaryPath, { encoding: 'utf8' }) as string)).toEqual(
      report
    );
    const defects = JSON.parse(safeReadFile(result.defectsPath, { encoding: 'utf8' }) as string);
    expect(defects.defects[0]).toMatchObject({
      defect_id: 'DEF-RUN-1-TEST-1',
      severity: 'critical',
    });
  });
});
