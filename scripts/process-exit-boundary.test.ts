import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

const ENTRYPOINTS = [
  'satellites/discord-bridge/src/index.ts',
  'satellites/imessage-bridge/src/index.ts',
  'satellites/slack-bridge/src/index.ts',
  'satellites/telegram-bridge/src/index.ts',
  'satellites/telegram-bridge/src/polling.ts',
  'presence/bridge/nexus-daemon.ts',
  'presence/displays/terminal-hud/src/main.ts',
] as const;

describe('long-lived entrypoint exit boundary', () => {
  it('keeps direct process termination centralized outside bridge entrypoints', () => {
    for (const relativePath of ENTRYPOINTS) {
      const source = String(
        safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' })
      );
      expect(source, relativePath).not.toContain('process.exit(');
    }
  });
});
