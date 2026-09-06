import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { safeReadFile } from '@agent/core/secure-io';

describe('presence studio runtime environment boundary', () => {
  it('uses the registered environment accessor for the default mission role', () => {
    const source = safeReadFile(
      fileURLToPath(new URL('./presence-studio-runtime-data.ts', import.meta.url)),
      { encoding: 'utf8' }
    );

    expect(source).not.toContain('process.env.MISSION_ROLE');
    expect(source).toContain("setRegisteredEnv('MISSION_ROLE', 'surface_runtime');");
  });

  it('validates minutes session JSON before microphone or consent side effects', () => {
    const source = safeReadFile(
      fileURLToPath(new URL('./presence-studio-runtime-data.ts', import.meta.url)),
      { encoding: 'utf8' }
    );

    expect(source).toContain("parseSafeJsonObjectValue(req.body, 'minutes session start body')");
    expect(source).toContain('presenceStudioMinutesSessionStartSchema.safeParse(requestBody)');
  });
});
