import { describe, expect, it } from 'vitest';
import { buildIMessageSendScript } from './imessage-bridge.js';

describe('imessage bridge', () => {
  it('builds a safe Messages AppleScript send command (legacy fallback)', () => {
    const script = buildIMessageSendScript({
      recipient: 'alice@example.com',
      text: 'Hello "Kyberion"',
    });

    expect(script).toContain('tell application "Messages"');
    expect(script).toContain('send "Hello \\"Kyberion\\"" to buddy "alice@example.com"');
  });
});
