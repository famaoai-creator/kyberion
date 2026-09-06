import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { loadSoftwareQualityReportAtPath } from './software-quality-report-reader.js';
import {
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  withExecutionContext,
} from './index.js';

const fixtureRoot = pathResolver.sharedTmp(`software-quality-report-${process.pid}`);

const validReport = () => ({
  version: '1.0.0',
  report_id: 'QUALITY-RUN-1',
  project_id: 'project-1',
  subject_ref: 'git:abc123',
  generated_at: '2026-09-03T00:00:00.000Z',
  gate_status: { dor: 'pass', acceptance_criteria: 'pass', dod: 'pass' },
  coverage: { required: 1, covered: 1 },
  execution: { planned: 1, passed: 1 },
  defects: { candidates: 0 },
  residual_risks: [],
  waiver_refs: [],
  recommendation: 'go',
  recommendation_reasons: [],
  evidence_refs: ['trace:1'],
  accountable_human_id: 'human:owner',
  human_decision: 'pending',
});

describe('software quality report loader', () => {
  afterEach(() => safeRmSync(fixtureRoot, { recursive: true, force: true }));

  it('loads a complete report through the path-bound catalog', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(fixtureRoot, { recursive: true });
      const filePath = path.join(fixtureRoot, 'report.json');
      safeWriteFile(filePath, JSON.stringify(validReport()));

      expect(loadSoftwareQualityReportAtPath(filePath)).toMatchObject({
        report_id: 'QUALITY-RUN-1',
        recommendation: 'go',
        human_decision: 'pending',
      });
    });
  });

  it('rejects malformed, directory, and symlink reports', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(fixtureRoot, { recursive: true });
      const malformedPath = path.join(fixtureRoot, 'malformed.json');
      const directoryPath = path.join(fixtureRoot, 'directory.json');
      const targetPath = path.join(fixtureRoot, 'target.json');
      const linkedPath = path.join(fixtureRoot, 'linked.json');
      safeWriteFile(malformedPath, JSON.stringify({ report_id: 'missing-contract' }));
      safeMkdir(directoryPath);
      safeWriteFile(targetPath, JSON.stringify(validReport()));
      safeSymlinkSync(targetPath, linkedPath);

      expect(() => loadSoftwareQualityReportAtPath(malformedPath)).toThrow(
        /Invalid catalog software-quality-report/
      );
      expect(() => loadSoftwareQualityReportAtPath(directoryPath)).toThrow(
        '[SOFTWARE_QUALITY_REPORT] report must be a regular file'
      );
      expect(() => loadSoftwareQualityReportAtPath(linkedPath)).toThrow('[RESOURCE_PATH_SYMLINK]');
    });
  });
});
