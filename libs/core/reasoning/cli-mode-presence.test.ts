import { describe, expect, it } from 'vitest';
import { cliModeAbsentFromDiscovery, isCliDiscoveryMode } from './cli-mode-presence.js';

describe('cliModeAbsentFromDiscovery', () => {
  const providers = [
    { provider: 'cursor', installed: false },
    { provider: 'claude', installed: true },
  ];

  it('skips a CLI mode discovery already reported as missing', () => {
    expect(cliModeAbsentFromDiscovery('cursor-cli', 'cursor', providers)).toBe(true);
  });

  it('keeps a CLI mode discovery reported as installed', () => {
    expect(cliModeAbsentFromDiscovery('claude-cli', 'claude', providers)).toBe(false);
  });

  it('does not skip API modes or an unknown provider snapshot', () => {
    expect(isCliDiscoveryMode('anthropic')).toBe(false);
    expect(cliModeAbsentFromDiscovery('anthropic', 'anthropic', providers)).toBe(false);
    expect(cliModeAbsentFromDiscovery('gemini-cli', 'gemini', providers)).toBe(false);
  });
});
