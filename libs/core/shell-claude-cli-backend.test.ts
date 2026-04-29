import { describe, expect, it } from 'vitest';
import {
  buildShellClaudeCliBackendFromEnv,
  probeShellClaudeCliAvailability,
} from './shell-claude-cli-backend.js';

describe('shell-claude-cli-backend', () => {
  it('returns null when the availability probe fails', () => {
    const backend = buildShellClaudeCliBackendFromEnv(
      { KYBERION_CLAUDE_CLI_BIN: 'claude' } as NodeJS.ProcessEnv,
      () => ({ available: false, reason: 'crash on launch' }),
    );

    expect(backend).toBeNull();
  });

  it('can report a missing binary as unavailable', () => {
    const probe = probeShellClaudeCliAvailability(
      { KYBERION_CLAUDE_CLI_BIN: '__definitely_missing_binary__' } as NodeJS.ProcessEnv,
      { bin: '__definitely_missing_binary__', timeoutMs: 250 },
    );

    expect(probe.available).toBe(false);
    expect(probe.reason).toBeTruthy();
  });
});
