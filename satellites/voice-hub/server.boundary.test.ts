import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { safeReadFile } from '@agent/core/secure-io';

describe('voice hub runtime environment boundary', () => {
  it('uses the registered environment accessor for the default mission role', () => {
    const source = safeReadFile(fileURLToPath(new URL('./server.ts', import.meta.url)), {
      encoding: 'utf8',
    });

    expect(source).not.toContain('process.env.MISSION_ROLE');
    expect(source).toContain("setRegisteredEnv('MISSION_ROLE', 'surface_runtime');");
  });

  it('propagates the detected reply locale through the shared surface contract path', () => {
    const source = safeReadFile(fileURLToPath(new URL('./server.ts', import.meta.url)), {
      encoding: 'utf8',
    });

    expect(source).toContain('locale: options?.locale,');
    expect(source).toContain('const locale = detectReplyLanguage(userText);');
    expect(source).toContain('locale,\n        }\n      )\n    );');
    expect(source).toContain(
      'formatChannelTurnText(result, { includeContract: false, locale }).trim()'
    );
    expect(source).toContain('locale,\n        tier: context.scope?.tier,');
  });

  it('keeps direct voice fallback replies in the shared vocabulary', () => {
    const source = safeReadFile(fileURLToPath(new URL('./server.ts', import.meta.url)), {
      encoding: 'utf8',
    });

    expect(source).toContain("t('surface:voice_hub_error_fallback', undefined, language)");
    expect(source).toContain(
      "t('surface:voice_hub_capability_summary', { capabilities }, language)"
    );
    expect(source).not.toContain('うまく処理できませんでした。もう一度お願いします。');
    expect(source).not.toContain('I could not process that. Please try again.');
  });
});
