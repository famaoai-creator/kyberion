import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('terminal-hud ask surface locale wiring', () => {
  it('passes the selected UI locale into the shared surface conversation', () => {
    const askSource = String(
      safeReadFile(pathResolver.rootResolve('presence/displays/terminal-hud/src/actions/ask.ts'), {
        encoding: 'utf8',
      })
    );
    const appSource = String(
      safeReadFile(pathResolver.rootResolve('presence/displays/terminal-hud/src/app.tsx'), {
        encoding: 'utf8',
      })
    );

    expect(askSource).toContain('locale?: SupportedLocale');
    expect(askSource).toContain('locale,\n      actorId:');
    expect(appSource).toContain('askKyberion(text, i18n.locale)');
  });
});
