import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { safeReadFile } from '@agent/core/secure-io';

describe('mission-asset execution-context boundary', () => {
  it('does not assign the request role to process-wide environment state', () => {
    const source = safeReadFile(fileURLToPath(new URL('./route.ts', import.meta.url)), {
      encoding: 'utf8',
    });

    expect(source).not.toContain('process.env.MISSION_ROLE =');
    expect(source).toContain('withViewerExecutionContext(resolvedViewer.context');
  });
});
