import { describe, expect, it } from 'vitest';
import { isClaudeCliAuthenticated } from './claude-cli-auth-status.js';

describe('claude-cli-auth-status', () => {
  it('trusts the structured loggedIn field over the process exit code', () => {
    expect(
      isClaudeCliAuthenticated({ ok: true, stdout: JSON.stringify({ loggedIn: false }) })
    ).toBe(false);
    expect(
      isClaudeCliAuthenticated({ ok: false, stdout: JSON.stringify({ loggedIn: true }) })
    ).toBe(false);
  });

  it('recognizes human-readable logged-out status', () => {
    expect(isClaudeCliAuthenticated({ ok: true, stdout: 'Not logged in' })).toBe(false);
  });

  it('falls back to the exit code for older human-readable success output', () => {
    expect(isClaudeCliAuthenticated({ ok: true, stdout: 'Logged in' })).toBe(true);
  });
});
