import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tier-guard.js', () => ({
  detectTier: (p: string) =>
    p.includes('knowledge/personal')
      ? 'personal'
      : p.includes('knowledge/confidential')
        ? 'confidential'
        : 'public',
  validateWritePermission: (p: string) =>
    p.includes('knowledge/personal')
      ? { allowed: false, reason: 'persona not authorized for personal tier' }
      : { allowed: true },
}));

const recordSpy = vi.fn((entry: any) => ({ id: 'AUD-TEST-1', ...entry }));
vi.mock('../governance/audit-chain.js', () => ({
  auditChain: { record: (e: any) => recordSpy(e) },
}));
vi.mock('../shell/shell-command-policy.js', () => ({
  evaluateShellCommandPolicy: (command: string) =>
    command.startsWith('pdftotext')
      ? {
          verdict: 'deny',
          command,
          executable: 'pdftotext',
          args: [],
          matchedRuleId: 'document-hand-extraction',
          reason:
            'Reading office / PDF files by hand is blocked — use `pnpm kyberion read <file>`.',
        }
      : command.includes('pnpm install')
        ? {
            verdict: 'require_approval',
            command,
            executable: 'pnpm',
            args: ['install'],
            reason: 'Shell command requires approval under Kyberion governance.',
          }
        : {
            verdict: 'allow',
            command,
            executable: 'ls',
            args: [],
            reason: 'Allowed by shell command policy.',
          },
}));

import {
  clearCoSessionNamespace,
  clearCoSessionStore,
  setCoSessionNamespace,
} from '../co-session.js';
import {
  buildPostCompactionContext,
  buildSessionEndContext,
  buildSessionStartContext,
  buildStopContext,
  buildUserPromptSubmitContext,
  evaluatePreToolUse,
  evaluatePreToolUseShellDeny,
  recordPostToolUse,
  resolveHookHostProvider,
} from './claude-code-hook.js';

// Hermeticity: the co-session bridge joins/drains/releases against the real
// store — keep every case in a throwaway namespace. Devin host markers are
// also neutralized so tests see the `claude` host unless they opt in.
const HOST_ENV_KEYS = ['DEVIN_PROJECT_DIR', 'CHISEL_SESSION_DB', 'AI_AGENT'] as const;
let savedHostEnv: Record<(typeof HOST_ENV_KEYS)[number], string | undefined>;
beforeEach(() => {
  setCoSessionNamespace(`claude-hook-test-${process.pid}`);
  clearCoSessionStore();
  savedHostEnv = Object.fromEntries(
    HOST_ENV_KEYS.map((k) => [k, process.env[k]])
  ) as typeof savedHostEnv;
  for (const k of HOST_ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  clearCoSessionStore();
  clearCoSessionNamespace();
  for (const k of HOST_ENV_KEYS) {
    if (savedHostEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedHostEnv[k];
  }
});

describe('claude-code-hook — PreToolUse tier-guard', () => {
  it('policy-gates Bash commands', () => {
    const out = evaluatePreToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');

    const denied = evaluatePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'pnpm install' },
    });
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('approval');
  });

  it('deny-only Bash gate blocks hand-rolled document extraction and stays silent otherwise', () => {
    const denied = evaluatePreToolUseShellDeny({
      tool_name: 'Bash',
      tool_input: { command: 'pdftotext -layout active/shared/tmp/job/final.pdf -' },
    });
    expect(denied?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied?.hookSpecificOutput.permissionDecisionReason).toContain('pnpm kyberion read');
    // Not allowlisted, but not denied either: defer to Claude Code's own prompts.
    expect(
      evaluatePreToolUseShellDeny({ tool_name: 'Bash', tool_input: { command: 'pnpm install' } })
    ).toBeNull();
    expect(
      evaluatePreToolUseShellDeny({ tool_name: 'Write', tool_input: { file_path: 'a.ts' } })
    ).toBeNull();
  });

  it('allows writes to ordinary source paths (public tier — not gated)', () => {
    const out = evaluatePreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: 'libs/core/foo.ts' },
    });
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
    const res = recordPostToolUse({
      tool_name: 'Write',
      tool_input: { file_path: 'knowledge/public/x.md' },
      cwd: '/repo',
    });
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

describe('claude-code-hook — UserPromptSubmit and Stop', () => {
  it('summarizes the prompt and suggests the next Kyberion step', () => {
    const ctx = buildUserPromptSubmitContext({
      prompt: 'Presentation deck for a proposal. Please validate the slides and open a mission.',
      cwd: '/repo',
    });

    expect(ctx).toContain('Prompt summary');
    expect(ctx).toContain('presentation preference profile');
    expect(ctx).toContain('mission');
  });

  it('records stop events without instructions that resume the turn', () => {
    const ctx = buildStopContext({
      reason: 'Stopping after the first draft and validation pass.',
      cwd: '/repo',
    });

    expect(ctx).toBe('');
    expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'claude_code_stop' }));
  });

  it('ignores recursive Stop invocations', () => {
    recordSpy.mockClear();
    expect(buildStopContext({ stop_hook_active: true })).toBe('');
    expect(recordSpy).not.toHaveBeenCalled();
  });
});

describe('claude-code-hook — host provider detection', () => {
  // The file-level beforeEach already clears the Devin env markers.
  it('defaults to claude when no Devin env markers are present', () => {
    expect(resolveHookHostProvider()).toBe('claude');
  });

  it('detects devin via DEVIN_PROJECT_DIR injected into hook processes', () => {
    process.env.DEVIN_PROJECT_DIR = '/repo';
    expect(resolveHookHostProvider()).toBe('devin');
  });

  it('detects devin via the AI_AGENT / CHISEL_SESSION_DB process env markers', () => {
    process.env.AI_AGENT = 'devin_3000-11-92_agent';
    expect(resolveHookHostProvider()).toBe('devin');
    delete process.env.AI_AGENT;
    process.env.CHISEL_SESSION_DB = '/tmp/sessions.db';
    expect(resolveHookHostProvider()).toBe('devin');
  });
});

describe('claude-code-hook — Devin tool aliasing and output shape', () => {
  it('gates Devin tool names through the same policy (exec → Bash, write → Write)', () => {
    const denied = evaluatePreToolUseShellDeny({
      tool_name: 'exec',
      tool_input: { command: 'pdftotext -layout active/shared/tmp/job/final.pdf -' },
    });
    expect(denied?.hookSpecificOutput.permissionDecision).toBe('deny');

    const tierDenied = evaluatePreToolUse({
      tool_name: 'write',
      tool_input: { file_path: 'knowledge/personal/secret.md' },
    });
    expect(tierDenied.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('records Devin exec/edit as their canonical tools in the audit chain', () => {
    recordSpy.mockClear();
    const res = recordPostToolUse({ tool_name: 'exec', tool_input: { command: 'pnpm test' } });
    expect(res.recorded).toBe(true);
    expect(recordSpy.mock.calls[0][0]).toMatchObject({ operation: 'Bash' });
    expect(recordPostToolUse({ tool_name: 'read', tool_input: {} }).recorded).toBe(false);
  });

  it('extracts apply_patch targets from patch text so patches cannot bypass the tier gate', () => {
    const denied = evaluatePreToolUse({
      tool_name: 'apply_patch',
      tool_input: {
        patch:
          '*** Begin Patch\n*** Update File: knowledge/personal/secret.md\n@@ -1 +1 @@\n*** End Patch',
      },
    });
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('personal tier');

    const diffDenied = evaluatePreToolUse({
      tool_name: 'apply_patch',
      tool_input: { patch: '--- a/libs/x.ts\n+++ b/knowledge/personal/y.md\n' },
    });
    expect(diffDenied.hookSpecificOutput.permissionDecision).toBe('deny');

    const allowed = evaluatePreToolUse({
      tool_name: 'apply_patch',
      tool_input: { patch: '*** Begin Patch\n*** Update File: libs/core/foo.ts\n*** End Patch' },
    });
    expect(allowed.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('audits write_to_process under its own name without capturing payload text', () => {
    recordSpy.mockClear();
    const res = recordPostToolUse({
      tool_name: 'write_to_process',
      tool_input: { shell_id: 's1', text_input: 'super-secret-input' },
    });
    expect(res.recorded).toBe(true);
    const entry = recordSpy.mock.calls[0][0];
    expect(entry).toMatchObject({ operation: 'write_to_process' });
    expect(entry.metadata).toMatchObject({ shell_id: 's1', input_kind: 'text' });
    expect(JSON.stringify(entry)).not.toContain('super-secret-input');
  });

  it('re-injects a governance reminder and re-joins presence on PostCompaction', () => {
    const ctx = buildPostCompactionContext({ session_id: 'compact-1' });
    expect(ctx).toContain('remains active after compaction');
    expect(ctx).toContain('/ky-review');
  });

  it('emits top-level decision/reason for Devin denies but not under Claude', () => {
    const claudeOut = evaluatePreToolUseShellDeny({
      tool_name: 'Bash',
      tool_input: { command: 'pdftotext x.pdf -' },
    });
    expect(claudeOut?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(claudeOut?.decision).toBeUndefined();

    process.env.DEVIN_PROJECT_DIR = '/repo';
    const devinOut = evaluatePreToolUseShellDeny({
      tool_name: 'exec',
      tool_input: { command: 'pdftotext x.pdf -' },
    });
    expect(devinOut?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(devinOut?.decision).toBe('block');
    expect(devinOut?.reason).toContain('pnpm kyberion read');
  });
});

describe('claude-code-hook — SessionEnd', () => {
  // The release path itself (coSessionHookEnd → leaveCoSession) is covered in
  // co-session-hook.test.ts; the mocked tier-guard here keeps secure-io writes
  // fail-closed, so only the store-free properties are asserted.
  it('Stop no longer touches co-session leases', () => {
    const ctx = buildStopContext({ reason: 'turn done', session_id: 's7' });
    expect(ctx).toBe('');
    expect(ctx).not.toContain('co-session');
  });

  it('is silent when nothing was leased', () => {
    expect(buildSessionEndContext({ session_id: 'nobody' })).toBe('');
  });
});
