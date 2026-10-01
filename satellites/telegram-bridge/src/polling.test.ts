import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('telegram polling entrypoint', () => {
  it('uses the shared script harness for direct startup', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('satellites/telegram-bridge/src/polling.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain(
      "import { defineScript, isDirectScript } from '@agent/core/script-harness'"
    );
    expect(source).toContain("name: 'telegram-polling'");
    expect(source).not.toContain('main().catch(');
    expect(source).not.toContain('console.error(err)');
  });
});

describe('telegram polling webhook target', () => {
  it('forwards to TELEGRAM_BRIDGE_PORT when the bridge listens on an override port', async () => {
    const previous = process.env.TELEGRAM_BRIDGE_PORT;
    try {
      const { resolveTelegramBridgeWebhookUrl } = await import('./polling.js');
      process.env.TELEGRAM_BRIDGE_PORT = '4123';
      expect(resolveTelegramBridgeWebhookUrl()).toBe('http://127.0.0.1:4123/webhook');
      process.env.TELEGRAM_BRIDGE_PORT = 'not-a-port';
      expect(() => resolveTelegramBridgeWebhookUrl()).toThrow(/TELEGRAM_BRIDGE_PORT/);
      delete process.env.TELEGRAM_BRIDGE_PORT;
      expect(resolveTelegramBridgeWebhookUrl()).toMatch(/^http:\/\/127\.0\.0\.1:3035\/webhook$/);
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_BRIDGE_PORT;
      else process.env.TELEGRAM_BRIDGE_PORT = previous;
    }
  });
});
