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
    expect(source).toContain('const locale = detectReplyLanguage(text);');
    expect(source).toContain(
      [
        '          const result = await runSurfaceMessageConversation(',
        '            buildPresenceSurfaceConversationMessageInput(',
        '              buildPresenceConversationPrompt(text, sessionKey),',
        '              {',
        '                surfaceText: text,',
        '                delegationSummaryInstruction:',
        "                  'Below are delegated responses. Produce the final spoken answer in the user language. Keep it concise and directly answer the user. Do not emit A2A blocks.',",
        '                scope,',
        '                locale,',
        '              }',
        '            )',
        '          );',
      ].join('\n')
    );
    expect(source).toContain(
      [
        '          const formattedText = formatChannelTurnText(result, {',
        '            includeContract: false,',
        '            locale,',
        '          }).trim();',
      ].join('\n')
    );
    expect(source).toContain('locale,\n              tier: scope?.tier,');
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
