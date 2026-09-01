import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync, safeSymlinkSync } from '@agent/core/secure-io';
import { buildCommandForOp, scaffoldApp } from './build-actuator-helpers.js';

const ROOT = process.cwd();

describe('build-actuator path boundaries', () => {
  it('rejects a project directory outside the repository', () => {
    expect(() =>
      buildCommandForOp({ op: 'android_build', project_dir: '/tmp/external-build-project' })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects a scaffold destination outside the repository', () => {
    expect(() =>
      scaffoldApp({
        op: 'scaffold_app',
        platform: 'ios',
        app_name: 'BoundaryApp',
        bundle_id: 'com.example.boundary',
        dest_dir: '/tmp/external-scaffold-destination',
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects a symlinked project directory', () => {
    const fixtureRoot = path.join(ROOT, 'active/shared/tmp/build-actuator-path-test');
    const target = path.join(fixtureRoot, 'target');
    const link = path.join(fixtureRoot, 'linked-project');
    safeRmSync(fixtureRoot, { recursive: true, force: true });
    safeMkdir(target, { recursive: true });
    safeSymlinkSync(target, link, 'dir');

    try {
      expect(() => buildCommandForOp({ op: 'ios_build', project_dir: link })).toThrow(
        '[RESOURCE_PATH_SYMLINK]'
      );
    } finally {
      safeRmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
