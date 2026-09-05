import { parseSafeJsonObjectInput } from './foundation/safe-json.js';

/** Resolve Claude CLI auth status from its cheap, non-interactive probe. */
export function isClaudeCliAuthenticated(input: {
  ok: boolean;
  stdout?: string;
  stderr?: string;
}): boolean {
  if (!input.ok) return false;
  const stdout = input.stdout?.trim() || '';
  if (stdout) {
    try {
      const parsed = parseSafeJsonObjectInput(stdout, 'Claude CLI auth status');
      if (typeof parsed?.loggedIn === 'boolean') return parsed.loggedIn;
    } catch {
      // Older or customized Claude CLIs may emit human-readable status text.
    }
  }

  const statusText = `${stdout}\n${input.stderr?.trim() || ''}`.toLowerCase();
  if (/\b(not logged in|logged out|unauthenticated)\b/u.test(statusText)) return false;
  return input.ok;
}
