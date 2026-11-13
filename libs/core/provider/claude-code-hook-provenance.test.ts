import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Writer-side stamp tests that must run with every test-run marker cleared (a
// real hook process carries none). Every store the bridge touches is mocked so
// nothing can resolve to live state while the markers are cleared.
const recordSpy = vi.fn((entry: any) => ({ id: 'AUD-PROV-1', ...entry }));
vi.mock('../governance/audit-chain.js', () => ({
  auditChain: { record: (e: any) => recordSpy(e) },
}));
vi.mock('../analysis/metrics.js', () => ({ metrics: { record: vi.fn() } }));
vi.mock('../tier-guard.js', () => ({
  detectTier: () => 'public',
  validateWritePermission: () => ({ allowed: true }),
}));
vi.mock('./co-session-hook.js', () => ({
  coSessionHookDrain: vi.fn(() => undefined),
  coSessionHookEnd: vi.fn(() => ({ released_leases: 0 })),
  coSessionHookJoin: vi.fn(() => ({ joined: false })),
  coSessionHookLeaseGate: vi.fn(() => ({ decision: 'allow' })),
  formatPendingHandoffs: vi.fn(() => ''),
}));

import { buildUserPromptSubmitContext, recordPostToolUse } from './claude-code-hook.js';
import { ALL_TEST_RUN_MARKER_ENV_KEYS } from '../foundation/env.js';
import { SESSION_HOOK_AUDIT_ACTION, isSessionHookAuditRow } from './session-hook-provenance.js';

function clearTestRunMarkers(): void {
  for (const key of ALL_TEST_RUN_MARKER_ENV_KEYS) vi.stubEnv(key, '');
  for (const key of ['DEVIN_PROJECT_DIR', 'CHISEL_SESSION_DB', 'AI_AGENT']) vi.stubEnv(key, '');
}

describe('claude-code-hook — session-hook stamp at the writer', () => {
  beforeEach(() => recordSpy.mockClear());
  afterEach(() => vi.unstubAllEnvs());

  it('stamps the UserPromptSubmit audit row of a host session', () => {
    clearTestRunMarkers();
    buildUserPromptSubmitContext({ prompt: 'fix the guard', session_id: 'sess-u' });
    vi.unstubAllEnvs();
    const row = recordSpy.mock.calls[0]![0];
    expect(row.action).toBe(SESSION_HOOK_AUDIT_ACTION.userPrompt);
    expect(row.metadata.session_hook).toEqual({
      host: 'claude',
      event: 'UserPromptSubmit',
      session_id: 'sess-u',
    });
    expect(isSessionHookAuditRow(row)).toBe(true);
  });

  it('does not stamp from a test child that cleared VITEST but kept the run id', () => {
    clearTestRunMarkers();
    vi.stubEnv('KYBERION_VITEST_RUN_ID', 'run-1');
    recordPostToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'sess-u' });
    vi.unstubAllEnvs();
    const row = recordSpy.mock.calls[0]![0];
    expect(row.metadata).not.toHaveProperty('session_hook');
    expect(isSessionHookAuditRow(row)).toBe(false);
  });
});
