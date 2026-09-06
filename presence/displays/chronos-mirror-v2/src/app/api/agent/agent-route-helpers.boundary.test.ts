import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { safeReadFile } from '@agent/core/secure-io';

describe('agent route helper execution-context boundary', () => {
  it('delegates mission-role scoping to the shared authority helper', () => {
    const source = safeReadFile(
      fileURLToPath(new URL('./agent-route-helpers.ts', import.meta.url)),
      {
        encoding: 'utf8',
      }
    );

    expect(source).not.toContain('process.env.MISSION_ROLE');
    expect(source).toContain('return withExecutionContext(role, fn);');
  });
});
