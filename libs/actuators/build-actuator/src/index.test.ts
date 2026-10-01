import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { buildCommandForOp, scaffoldApp } from './build-actuator-helpers.js';
import { actuator } from './index.js';

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

describe('build-actuator command planning', () => {
  const fixtureRoot = path.join(ROOT, 'active/shared/tmp/build-actuator-command-test');
  const iosDir = 'active/shared/tmp/build-actuator-command-test/ios';
  const androidDir = 'active/shared/tmp/build-actuator-command-test/android';

  function withFixtures(run: () => void): void {
    safeRmSync(fixtureRoot, { recursive: true, force: true });
    safeMkdir(path.join(ROOT, iosDir, 'Demo.xcodeproj'), { recursive: true });
    safeMkdir(path.join(ROOT, androidDir), { recursive: true });
    safeWriteFile(path.join(ROOT, androidDir, 'gradlew'), '#!/bin/sh\n');
    try {
      run();
    } finally {
      safeRmSync(fixtureRoot, { recursive: true, force: true });
    }
  }

  it('plans the iOS project generation, test and archive commands', () => {
    withFixtures(() => {
      expect(buildCommandForOp({ op: 'ios_generate_project', project_dir: iosDir })).toEqual({
        command: 'xcodegen',
        args: ['generate'],
        cwd: path.join(ROOT, iosDir),
      });
      const test = buildCommandForOp({
        op: 'ios_test',
        project_dir: iosDir,
        scheme: 'Demo',
        simulator: 'iPhone 16',
      });
      expect(test.args).toEqual([
        'test',
        '-project',
        'Demo.xcodeproj',
        '-scheme',
        'Demo',
        '-destination',
        'platform=iOS Simulator,name=iPhone 16',
      ]);
      const archive = buildCommandForOp({ op: 'ios_archive', project_dir: iosDir, scheme: 'Demo' });
      expect(archive.args).toEqual([
        'archive',
        '-project',
        'Demo.xcodeproj',
        '-scheme',
        'Demo',
        'CODE_SIGNING_ALLOWED=NO',
      ]);
    });
  });

  it('plans the Android unit/connected test and release bundle commands via gradlew', () => {
    withFixtures(() => {
      expect(buildCommandForOp({ op: 'android_test', project_dir: androidDir })).toMatchObject({
        command: './gradlew',
        args: ['testDebugUnitTest'],
      });
      expect(
        buildCommandForOp({ op: 'android_test', project_dir: androidDir, connected: true }).args
      ).toEqual(['testDebugUnitTest', 'connectedDebugAndroidTest']);
      expect(buildCommandForOp({ op: 'android_bundle', project_dir: androidDir })).toMatchObject({
        command: './gradlew',
        args: ['bundleRelease'],
      });
    });
  });
});

describe('build-actuator SDK dispatch (pipeline / ADF path)', () => {
  it('passes the op and its flat params to the build handler', async () => {
    const result = await actuator.dispatch('android_test', {
      project_dir: '/tmp/external-build-project',
    });
    // The handler saw op + project_dir: it failed on the path guard, not on a missing op.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('[RESOURCE_PATH_SCOPE]');
  });
});
