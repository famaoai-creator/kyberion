import { describe, expect, it, vi } from 'vitest';

vi.mock('./tier-guard.js', () => ({
  detectTier: (p: string) =>
    p.includes('knowledge/personal') ? 'personal' : p.includes('knowledge/confidential') ? 'confidential' : 'public',
  validateWritePermission: (p: string) =>
    p.includes('knowledge/personal')
      ? { allowed: false, reason: 'persona not authorized for personal tier' }
      : { allowed: true },
}));

const recordSpy = vi.fn((entry: any) => ({ id: 'AUD-TEST-1', ...entry }));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: (e: any) => recordSpy(e) } }));

import {
  buildSessionStartContext,
  evaluatePreToolUse,
  recordPostToolUse,
} from './claude-code-hook.js';

describe('claude-code-hook — PreToolUse tier-guard', () => {
  it('allows non-file tools', () => {
    const out = evaluatePreToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows writes to ordinary source paths (public tier — not gated)', () => {
    const out = evaluatePreToolUse({ tool_name: 'Write', tool_input: { file_path: 'libs/core/foo.ts' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('denies writes into a protected knowledge tier, surfacing the tier + reason', () => {
    const out = evaluatePreToolUse({
      tool_name: 'Edit',
      tool_input: { file_path: 'knowledge/personal/secret.md' },
    });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('personal tier');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('not authorized');
  });
});

describe('claude-code-hook — PostToolUse audit', () => {
  it('records Write into the audit chain with tier metadata', () => {
    recordSpy.mockClear();
    const res = recordPostToolUse({ tool_name: 'Write', tool_input: { file_path: 'knowledge/public/x.md' }, cwd: '/repo' });
    expect(res.recorded).toBe(true);
    expect(res.entryId).toBe('AUD-TEST-1');
    const entry = recordSpy.mock.calls[0][0];
    expect(entry).toMatchObject({ agentId: 'claude-code', operation: 'Write' });
    expect(entry.metadata).toMatchObject({ file_path: 'knowledge/public/x.md', tier: 'public' });
  });

  it('records Bash with a truncated command', () => {
    recordSpy.mockClear();
    const res = recordPostToolUse({ tool_name: 'Bash', tool_input: { command: 'pnpm test' } });
    expect(res.recorded).toBe(true);
    expect(recordSpy.mock.calls[0][0].metadata.command).toBe('pnpm test');
  });

  it('does not audit untracked tools', () => {
    recordSpy.mockClear();
    const res = recordPostToolUse({ tool_name: 'Read', tool_input: { file_path: 'x' } });
    expect(res.recorded).toBe(false);
    expect(recordSpy).not.toHaveBeenCalled();
  });
});

describe('claude-code-hook — SessionStart', () => {
  it('mentions tier-guard, audit, and the lifecycle commands', () => {
    const ctx = buildSessionStartContext();
    expect(ctx).toContain('tier-guard');
    expect(ctx).toContain('audit chain');
    expect(ctx).toContain('/ky-baseline');
  });
});
