import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';

describe('cost route environment boundary', () => {
  it('uses the registered accessor for the server-side budget fallback', () => {
    const source = safeReadFile(fileURLToPath(new URL('./route.ts', import.meta.url)), {
      encoding: 'utf8',
    }) as string;

    expect(source).toContain("getRegisteredEnvText('CHRONOS_COST_BUDGET_USD')");
    expect(source).not.toContain('process.env.CHRONOS_COST_BUDGET_USD');
  });
});
