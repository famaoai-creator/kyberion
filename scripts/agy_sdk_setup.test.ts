import { describe, expect, it } from 'vitest';
import { formatAgySdkReport } from './agy_sdk_setup.js';

describe('AGY SDK setup report', () => {
  it('formats the non-applying recovery instruction without process output', () => {
    const lines = formatAgySdkReport(
      {
        managedEnvPath: '/tmp/agy',
        pythonBin: null,
        status: 'needs_install',
        detail: 'runtime unavailable',
      },
      false
    );

    expect(lines).toEqual([
      '[WARN] agy_sdk',
      '  managed_env: /tmp/agy',
      '  detail: runtime unavailable',
      'Next step: `pnpm agy:sdk:setup --apply`',
    ]);
  });
});
