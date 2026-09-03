import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  resolveFirstWinResourcePath,
  validateFirstWinLifecycleLiveOptions,
} from './first_win_lifecycle_smoke.js';

const root = pathResolver.sharedTmp(`first-win-lifecycle-boundary-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

describe('first-win lifecycle resource boundary', () => {
  it('uses the shared safe parser for command JSON output', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/first_win_lifecycle_smoke.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('parseSafeJsonInput(');
    expect(source).not.toContain('JSON.parse(');
  });

  it('uses the canonical pipeline loader for the schedule contract', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/first_win_lifecycle_smoke.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadPipelineAdfAtPath(');
    expect(source).not.toContain('readJson<{ schedule?:');
  });

  it('uses the canonical onboarding input loader for the identity contract', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/first_win_lifecycle_smoke.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadOnboardingApplyInputAtPath(');
    expect(source).not.toContain('readJson<{ identity?:');
  });

  it('rejects repository-external identity resources', () => {
    expect(() => resolveFirstWinResourcePath('/tmp/first-win-identity.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    expect(
      validateFirstWinLifecycleLiveOptions({
        identityFile: '/tmp/first-win-identity.json',
        runId: '20260901-a',
        confirm: 'FIRST-WIN-LIFECYCLE-LIVE',
        allowWrites: '1',
      })
    ).toEqual([expect.stringContaining('[RESOURCE_PATH_SCOPE]')]);
  });

  it('rejects symlinked identity resources', () => {
    const target = path.join(root, 'target');
    const link = path.join(root, 'identity.json');
    safeMkdir(target, { recursive: true });
    safeWriteFile(path.join(target, 'identity.json'), '{}\n');
    safeSymlinkSync(path.join(target, 'identity.json'), link);

    expect(() => resolveFirstWinResourcePath(link)).toThrow('[RESOURCE_PATH_SYMLINK]');
    expect(
      validateFirstWinLifecycleLiveOptions({
        identityFile: link,
        runId: '20260901-b',
        confirm: 'FIRST-WIN-LIFECYCLE-LIVE',
        allowWrites: '1',
      })
    ).toEqual([expect.stringContaining('[RESOURCE_PATH_SYMLINK]')]);
  });
});
