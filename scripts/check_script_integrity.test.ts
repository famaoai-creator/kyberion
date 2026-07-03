import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { checkScriptIntegrity } from './check_script_integrity.js';

const FIXTURE_DIR = pathResolver.sharedTmp('check-script-integrity');

function writeJson(relativePath: string, payload: unknown): string {
  const fullPath = pathResolver.sharedTmp(`check-script-integrity/${relativePath}`);
  safeMkdir(
    pathResolver.sharedTmp(
      `check-script-integrity/${relativePath.split('/').slice(0, -1).join('/')}`
    )
  );
  safeWriteFile(fullPath, JSON.stringify(payload, null, 2));
  return fullPath;
}

describe('check_script_integrity', () => {
  afterEach(() => {
    if (safeExistsSync(FIXTURE_DIR)) {
      safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  it('flags dist script references without TypeScript sources', () => {
    const packageJsonPath = writeJson('package.json', {
      scripts: {
        broken: 'node dist/scripts/definitely_missing.js',
      },
    });

    const violations = checkScriptIntegrity({ packageJsonPath, pipelineRoots: [] });

    expect(violations).toEqual([
      'package.json scripts.broken: dist/scripts/definitely_missing.js has no source scripts/definitely_missing.ts',
    ]);
  });

  it('flags missing repo-local paths inside pipeline definitions', () => {
    writeJson('pipelines/broken.json', {
      steps: [
        {
          op: 'system:exec',
          params: {
            command: 'node',
            args: ['libs/missing/tool.mjs'],
          },
        },
      ],
    });

    const packageJsonPath = writeJson('package.json', { scripts: {} });
    const violations = checkScriptIntegrity({
      packageJsonPath,
      pipelineRoots: ['active/shared/tmp/check-script-integrity/pipelines'],
    });

    expect(violations).toEqual([
      'active/shared/tmp/check-script-integrity/pipelines/broken.json: referenced path not found (libs/missing/tool.mjs)',
    ]);
  });
});
