import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { safeReadFile } from '@agent/core/secure-io';

describe('agents execution-context boundary', () => {
  it('does not assign a request role to process-wide environment state', () => {
    const source = safeReadFile(fileURLToPath(new URL('./route.ts', import.meta.url)), {
      encoding: 'utf8',
    });

    expect(source).not.toContain('process.env.MISSION_ROLE =');
    expect(source).toContain('withViewerExecutionContextAsync(resolvedViewer.context');
  });
});
