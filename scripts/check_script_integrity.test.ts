import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { checkScriptIntegrity, findDirectScriptGuardViolations } from './check_script_integrity.js';

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

  it('requires compiled direct-script guards alongside TypeScript guards', () => {
    expect(
      findDirectScriptGuardViolations(
        'scripts/example.ts',
        "if (isDirectScript(import.meta.url, 'example.ts')) void main();"
      )
    ).toEqual(['scripts/example.ts: direct-script guard is missing compiled entry example.js']);
    expect(
      findDirectScriptGuardViolations(
        'scripts/example.ts',
        "if (isDirectScript(import.meta.url, 'example.ts') || isDirectScript(import.meta.url, 'example.js')) void main();"
      )
    ).toEqual([]);
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

  it('flags TypeScript execution scripts without build output', () => {
    const packageJsonPath = writeJson('package.json', {
      scripts: {
        broken: 'node --import ./scripts/ts-loader.mjs scripts/demos/demo_imessage_flow.ts',
      },
    });

    const violations = checkScriptIntegrity({
      packageJsonPath,
      pipelineRoots: [],
      pathExists: (repoRelativePath) =>
        repoRelativePath === 'scripts/ts-loader.mjs' ||
        repoRelativePath === 'scripts/demos/demo_imessage_flow.ts',
    });

    expect(violations).toEqual([
      'package.json scripts.broken: scripts/demos/demo_imessage_flow.ts has no build output dist/scripts/demos/demo_imessage_flow.js',
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

  it('flags missing pnpm scripts inside pipeline definitions', () => {
    writeJson('pipelines/broken.json', {
      steps: [{ op: 'system:exec', params: { cmd: 'pnpm run check:removed-gate' } }],
    });

    const packageJsonPath = writeJson('package.json', { scripts: { typecheck: 'tsc --noEmit' } });
    const violations = checkScriptIntegrity({
      packageJsonPath,
      pipelineRoots: ['active/shared/tmp/check-script-integrity/pipelines'],
    });

    expect(violations).toEqual([
      'active/shared/tmp/check-script-integrity/pipelines/broken.json: pnpm script not found (check:removed-gate)',
    ]);
  });
});
