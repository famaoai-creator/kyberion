import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const ROOT = process.cwd();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

describe('reference drift contract', () => {
  const criticalFiles = [
    '.github/workflows/ci.yml',
    '.github/workflows/pr-validation.yml',
    '.github/workflows/README.md',
    'package.json',
    'knowledge/public/governance/phases/onboarding.md',
    'docs/developer/LOCAL_DEV.md',
    'docs/PRODUCTIZATION_ROADMAP.md',
    'pipelines/fragments/capability-docs-sync.json',
    'pipelines/orchestration-jobs.json',
    'tests/workflow-operations-contract.test.ts',
    'tests/fixtures/governance-import-baseline.json',
  ];

  const removedScriptRefs = [
    'measure-build-size.ts',
    'measure-build-size.js',
    'docs_sync.ts',
    'docs_sync.js',
    'run_orchestration_job.ts',
    'run_orchestration_job.js',
  ];

  it('keeps critical workflow and onboarding references on current script names', () => {
    const contents = criticalFiles.map((file) => `${file}\n${read(file)}`).join('\n');
    for (const ref of removedScriptRefs) {
      expect(contents).not.toContain(ref);
    }
    expect(contents).toContain('vital_check.js');
    expect(contents).toContain('onboard:apply');
    expect(contents).toContain('check:doc-examples');
  });
});
