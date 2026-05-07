import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeRmSync, safeWriteFile } from '@agent/core';
import { scanPipelineShellIndependence } from './check_pipeline_shell_independence.js';

const PROBE = pathResolver.sharedTmp('pipeline-shell-independence-probe.json');

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
});
