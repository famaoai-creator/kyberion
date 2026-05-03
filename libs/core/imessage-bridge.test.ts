import { describe, expect, it } from 'vitest';
import { buildIMessageSendScript } from './imessage-bridge.js';

describe('imessage bridge', () => {
  it('builds a safe Messages AppleScript send command', () => {
    const script = buildIMessageSendScript({
      recipient: 'alice@example.com',
      text: 'Hello "Kyberion"',
      serviceName: 'iMessage',
    });

    expect(script).toContain('tell application "Messages"');
    expect(script).toContain('service type contains "iMessage"');
    expect(script).toContain('set targetBuddy to buddy "alice@example.com" of targetService');
    expect(script).toContain('send "Hello \\"Kyberion\\"" to targetBuddy');
  });
});
