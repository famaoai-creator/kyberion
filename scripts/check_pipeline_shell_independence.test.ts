import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadJson,
  pathResolver,
  resolveActuatorOperation,
  safeExistsSync,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { scanPipelineShellIndependence } from './check_pipeline_shell_independence.js';

const PROBE = pathResolver.sharedTmp('pipeline-shell-independence-probe.json');
type PipelineFixture = { steps: Array<{ id?: string; op?: string }> };

describe('check_pipeline_shell_independence', () => {
  let savedPersona: string | undefined;
  let savedRole: string | undefined;

  beforeEach(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
  });

  afterEach(() => {
    if (safeExistsSync(PROBE)) {
      safeRmSync(PROBE, { force: true });
    }
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });

  it('flags host-specific shell substitutions', () => {
    safeWriteFile(
      PROBE,
      JSON.stringify(
        {
          steps: [
            {
              op: 'system:shell',
              params: {
                cmd: 'echo "$(pwd)" && test "$(uname -s)" = Darwin',
              },
            },
          ],
        },
        null,
        2
      )
    );

    const violations = scanPipelineShellIndependence([PROBE]);

    expect(violations.some((v) => v.pattern === 'pwd-substitution')).toBe(true);
    expect(violations.some((v) => v.pattern === 'uname-substitution')).toBe(true);
  });

  it('flags implicit host temp paths and direct shell interpreter escapes', () => {
    safeWriteFile(
      PROBE,
      JSON.stringify(
        {
          context: {
            output_path: '/tmp/kyberion-report.json',
          },
          steps: [
            {
              op: 'system:shell',
              params: {
                cmd: 'bash -c "echo unsafe"',
              },
            },
          ],
        },
        null,
        2
      )
    );

    const violations = scanPipelineShellIndependence([PROBE]);

    expect(violations.some((v) => v.pattern === 'implicit-host-temp-path')).toBe(true);
    expect(violations.some((v) => v.pattern === 'shell-interpreter')).toBe(true);
  });

  it('allows repo-managed shared temp artifacts', () => {
    safeWriteFile(
      PROBE,
      JSON.stringify(
        {
          context: {
            output_path: 'active/shared/tmp/kyberion-report.json',
          },
          steps: [
            {
              op: 'system:shell',
              params: {
                cmd: 'printf report > active/shared/tmp/kyberion-report.json',
              },
            },
          ],
        },
        null,
        2
      )
    );

    const violations = scanPipelineShellIndependence([PROBE]);

    expect(violations).toEqual([]);
  });

  it('flags typed node, pnpm, and npx script wrappers', () => {
    safeWriteFile(
      PROBE,
      JSON.stringify(
        {
          steps: [
            {
              op: 'system:exec',
              params: { command: 'node', args: ['dist/scripts/task.js'] },
            },
            {
              op: 'system:exec',
              params: { command: 'pnpm', args: ['exec', 'tsx', 'scripts/task.ts'] },
            },
            {
              op: 'system:exec',
              params: { command: 'npx', args: ['tsx', 'scripts/task.ts'] },
            },
          ],
        },
        null,
        2
      )
    );

    const violations = scanPipelineShellIndependence([PROBE]);

    expect(violations.filter((v) => v.pattern === 'script-wrapper')).toHaveLength(3);
  });

  it('flags raw shell wrappers and nested steps while allowing native health checks', () => {
    safeWriteFile(
      PROBE,
      JSON.stringify(
        {
          steps: [
            {
              op: 'core:if',
              params: {
                then: [
                  {
                    op: 'system:shell',
                    params: { cmd: 'node dist/libs/actuators/browser/index.js --input x.json' },
                  },
                  {
                    op: 'system:shell',
                    params: { cmd: 'npx tsx scripts/task.ts' },
                  },
                ],
              },
            },
            {
              op: 'system:cli_health_check',
              params: { command: 'node' },
            },
          ],
        },
        null,
        2
      )
    );

    const violations = scanPipelineShellIndependence([PROBE]);

    expect(violations.filter((v) => v.pattern === 'script-wrapper')).toHaveLength(2);
  });

  it('locks the selected SX-11 migrations to their declared native actuator ops', () => {
    const promoNarratedDemo = loadJson<PipelineFixture>(
      pathResolver.rootResolve(
        'knowledge/product/pipeline-templates/kyberion-promo-narrated-demo.json'
      )
    );
    const vtuberSubmit = loadJson<PipelineFixture>(
      pathResolver.rootResolve('pipelines/kyberion-vtuber-narrated-demo-submit.json')
    );
    const selectedFiles = [
      pathResolver.rootResolve(
        'knowledge/product/pipeline-templates/kyberion-promo-narrated-demo.json'
      ),
      pathResolver.rootResolve('pipelines/kyberion-vtuber-narrated-demo-submit.json'),
    ];

    expect(promoNarratedDemo.steps.find((step) => step.id === 'generate_voice')).toMatchObject({
      op: 'voice:generate_voice',
    });
    expect(promoNarratedDemo.steps.find((step) => step.id === 'generate_video')).toMatchObject({
      op: 'video-composition:create_narrated_video_from_content_brief',
    });
    expect(vtuberSubmit.steps.find((step) => step.id === 'generate_voice')).toMatchObject({
      op: 'voice:generate_voice',
    });

    expect(resolveActuatorOperation('voice', 'generate_voice')).toMatchObject({
      actuatorId: 'voice-actuator',
      modulePath: 'dist/libs/actuators/voice-actuator/src/index.js',
    });
    expect(
      resolveActuatorOperation('video-composition', 'create_narrated_video_from_content_brief')
    ).toMatchObject({
      actuatorId: 'video-composition-actuator',
      modulePath: 'dist/libs/actuators/video-composition-actuator/src/index.js',
    });

    expect(
      scanPipelineShellIndependence(selectedFiles).filter(
        (violation) => violation.pattern === 'script-wrapper'
      )
    ).toEqual([]);
  });
});
