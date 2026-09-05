import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('meeting preflight environment boundary', () => {
  it('routes ambient mission fallback through the governed environment accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/meeting_preflight.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.env.MISSION_ID?.trim()');
    expect(source).not.toContain('|| process.env.MISSION_ID');
    expect(source).toContain("getRegisteredEnvText('MISSION_ID')");
  });
});
