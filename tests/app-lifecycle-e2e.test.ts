import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildCommandForOp,
  extractErrorSummary,
  handleAction,
  scaffoldApp,
} from '../libs/actuators/build-actuator/src/build-actuator-helpers.js';
import { compileTestInventoryToDevicePipeline } from '../libs/actuators/modeling-actuator/src/modeling-pipeline-helpers.js';
import { pathResolver, safeExistsSync, safeReadFile, safeRmSync } from '@agent/core';

/**
 * E2E-05 Task 7: app-lifecycle rehearsal.
 * The mock/contract section always runs (op → command assembly, scaffolding,
 * device-pipeline compilation). The real-toolchain rehearsal is opt-in via
 * KYBERION_MOBILE_TOOLCHAIN=1 (skipped in CI by default).
 */

describe('build-actuator command contracts (E2E-05 Task 2)', () => {
  it('assembles xcodebuild commands with simulator destinations', () => {
    const build = buildCommandForOp({
      op: 'ios_build',
      project_dir: 'active/shared/tmp/x',
      scheme: 'MyApp',
    });
    expect(build.command).toBe('xcodebuild');
    // -target + -sdk iphonesimulator: scheme destination resolution requires
    // device platform components even for simulator builds on recent Xcode —
    // verified against real Xcode 26 in the E2E-05 dog-food run.
    expect(build.args).toContain('-target');
    expect(build.args).toContain('iphonesimulator');
    expect(build.args).toContain('CODE_SIGNING_ALLOWED=NO');

    const test = buildCommandForOp({
      op: 'ios_test',
      project_dir: 'active/shared/tmp/x',
      scheme: 'MyApp',
    });
    expect(test.args[0]).toBe('test');
    expect(test.args.join(' ')).toContain('platform=iOS Simulator,name=iPhone 15');

    const archive = buildCommandForOp({ op: 'ios_archive', project_dir: 'active/shared/tmp/x' });
    expect(archive.args).toContain('CODE_SIGNING_ALLOWED=NO');
  });

  it('assembles gradle commands (gradle fallback without wrapper)', () => {
    const build = buildCommandForOp({
      op: 'android_build',
      project_dir: 'active/shared/tmp/no-wrapper',
    });
    expect(build.command).toBe('gradle');
    expect(build.args).toEqual(['assembleDebug']);

    const test = buildCommandForOp({
      op: 'android_test',
      project_dir: 'active/shared/tmp/no-wrapper',
      connected: true,
    });
    expect(test.args).toEqual(['testDebugUnitTest', 'connectedDebugAndroidTest']);

    const bundle = buildCommandForOp({
      op: 'android_bundle',
      project_dir: 'active/shared/tmp/no-wrapper',
    });
    expect(bundle.args).toEqual(['bundleRelease']);
  });

  it('extracts a bounded error summary from build logs', () => {
    const log = [
      'compiling…',
      ...Array.from({ length: 20 }, (_, index) => `error: problem ${index}`),
      'BUILD FAILED',
    ].join('\n');
    const summary = extractErrorSummary(log);
    expect(summary.length).toBeLessThanOrEqual(10);
    expect(summary[summary.length - 1]).toBe('BUILD FAILED');
  });

  it('requires project_dir for build ops', async () => {
    await expect(handleAction({ op: 'android_build' })).rejects.toThrow(/project_dir/);
  });
});

describe('scaffold_app (E2E-05 Task 3)', () => {
  it('copies the fixture and replaces placeholders for both platforms', () => {
    const destBase = `active/shared/tmp/e2e05-scaffold-${randomUUID()}`;
    try {
      const android = scaffoldApp({
        op: 'scaffold_app',
        platform: 'android',
        app_name: 'FixtureApp',
        bundle_id: 'dev.kyberion.fixture',
        dest_dir: `${destBase}/android`,
      });
      expect(android.ok).toBe(true);
      const manifest = String(
        safeReadFile(
          pathResolver.rootResolve(`${destBase}/android/app/src/main/AndroidManifest.xml`),
          {
            encoding: 'utf8',
          }
        )
      );
      expect(manifest).toContain('android:label="FixtureApp"');
      expect(manifest).toContain('dev.kyberion.fixture.MainActivity');
      expect(manifest).not.toContain('{{APP_NAME}}');

      const ios = scaffoldApp({
        op: 'scaffold_app',
        platform: 'ios',
        app_name: 'FixtureApp',
        bundle_id: 'dev.kyberion.fixture',
        dest_dir: `${destBase}/ios`,
      });
      expect(ios.ok).toBe(true);
      const projectYml = String(
        safeReadFile(pathResolver.rootResolve(`${destBase}/ios/project.yml`), { encoding: 'utf8' })
      );
      expect(projectYml).toContain('name: FixtureApp');
      expect(projectYml).toContain('PRODUCT_BUNDLE_IDENTIFIER: dev.kyberion.fixture');
    } finally {
      const resolved = pathResolver.rootResolve(destBase);
      if (safeExistsSync(resolved)) safeRmSync(resolved);
    }
  });
});

describe('test-case-adf → device pipeline (E2E-05 Task 5)', () => {
  const tests = {
    kind: 'test-case-adf' as const,
    app_id: 'dev.kyberion.fixture',
    cases: [
      {
        case_id: 'TC-1',
        title: 'login',
        objective: 'user can log in',
        steps: ['input "alice" into "username"', 'tap "ログイン"'],
        expected: ['「ようこそ」が表示される'],
        automation_backend: 'android' as const,
      },
    ],
  };

  it('compiles android cases into find/tap/input + assertion + screenshot steps', () => {
    const pipeline = compileTestInventoryToDevicePipeline(
      tests,
      { package: 'dev.kyberion.fixture', launch_component: 'dev.kyberion.fixture/.MainActivity' },
      { platform: 'android', artifactsDir: 'active/shared/tmp/test-runs' }
    );
    const ops = pipeline.steps.map((step) => step.op);
    expect(ops[0]).toBe('launch_app');
    expect(ops).toContain('input_text_into_ui_node');
    expect(ops).toContain('tap_ui_node');
    expect(ops).toContain('wait_for_ui_text');
    expect(ops[ops.length - 1]).toBe('capture_screen');
    const input = pipeline.steps.find((step) => step.op === 'input_text_into_ui_node')!;
    expect(input.params.text).toBe('alice');
    const assertion = pipeline.steps.find((step) => step.op === 'wait_for_ui_text')!;
    expect(assertion.params.text).toBe('ようこそ');
  });

  it('compiles ios cases into deep-link + screenshot evidence (interaction is residual)', () => {
    const iosTests = {
      ...tests,
      cases: [
        {
          ...tests.cases[0],
          automation_backend: 'ios' as const,
          steps: ['open kyberion://home', 'tap "設定"'],
        },
      ],
    };
    const pipeline = compileTestInventoryToDevicePipeline(
      iosTests,
      { bundle_id: 'dev.kyberion.fixture' },
      { platform: 'ios', artifactsDir: 'active/shared/tmp/test-runs' }
    );
    const ops = pipeline.steps.map((step) => step.op);
    expect(ops).toContain('boot_simulator');
    expect(ops).toContain('launch_app');
    expect(ops).toContain('open_deep_link');
    expect(ops).toContain('log');
    expect(ops[ops.length - 1]).toBe('capture_screen');
  });
});

describe.skipIf(!process.env.KYBERION_MOBILE_TOOLCHAIN)(
  'real toolchain rehearsal (KYBERION_MOBILE_TOOLCHAIN=1)',
  () => {
    it(
      'scaffold → android_build produces an APK',
      async () => {
        const dest = `active/shared/tmp/e2e05-real-${randomUUID()}/android`;
        const scaffolded = scaffoldApp({
          op: 'scaffold_app',
          platform: 'android',
          app_name: 'RehearsalApp',
          bundle_id: 'dev.kyberion.rehearsal',
          dest_dir: dest,
        });
        expect(scaffolded.ok).toBe(true);
        const result = await handleAction({ op: 'android_build', project_dir: dest });
        expect(result.ok).toBe(true);
      },
      45 * 60 * 1000
    );
  }
);
