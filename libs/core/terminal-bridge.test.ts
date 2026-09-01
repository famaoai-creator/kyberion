import { describe, expect, it } from 'vitest';
import { terminalBridge } from './terminal-bridge.js';

describe('terminal-bridge path boundaries', () => {
  it('rejects session ids that escape the governed runtime directory', async () => {
    await expect(
      terminalBridge.injectAndExecute('', '../outside', 'echo unsafe', 'ReflexTerminal')
    ).resolves.toBe(false);
    expect(terminalBridge.readLatestOutput('', '../outside', 'ReflexTerminal')).toBe('');
  });
});
