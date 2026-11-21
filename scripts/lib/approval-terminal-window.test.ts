import { describe, expect, it } from 'vitest';
import { planApprovalWindow } from './approval-terminal-window.js';

const base = {
  repoRoot: '/work/kyberion',
  scriptDir: '/work/kyberion/active/shared/tmp/approval-window',
};

describe('planApprovalWindow', () => {
  it('opens a macOS .command window that runs the ordinary decision command', () => {
    const plan = planApprovalWindow({
      ...base,
      platform: 'darwin',
      requestId: 'apr-123',
      decision: 'approve',
    });
    expect(plan.kind).toBe('launch');
    if (plan.kind !== 'launch') return;
    expect(plan.scriptPath).toBe(
      '/work/kyberion/active/shared/tmp/approval-window/approve-apr-123.command'
    );
    expect(plan.scriptBody).toContain("cd '/work/kyberion' || exit 1");
    expect(plan.scriptBody).toContain('pnpm kyberion approvals --approve apr-123\n');
    // The window only runs the same command a person would type: no bypass flags.
    expect(plan.scriptBody).not.toMatch(/--yes|--force|--skip|CLAUDE|env -i/u);
  });

  it('opens a Windows .cmd window for a deny', () => {
    const plan = planApprovalWindow({
      platform: 'win32',
      repoRoot: 'C:\\work\\kyberion',
      scriptDir: 'C:\\work\\kyberion\\active\\shared\\tmp\\approval-window',
      requestId: 'apr-9',
      decision: 'deny',
    });
    expect(plan.kind).toBe('launch');
    if (plan.kind === 'launch') {
      expect(plan.scriptBody).toContain('call pnpm kyberion approvals --deny apr-9');
      expect(plan.scriptBody).toContain('cd /d "C:\\work\\kyberion"');
    }
  });

  it('tells Linux users which command to run in their own terminal', () => {
    const plan = planApprovalWindow({
      ...base,
      platform: 'linux',
      requestId: 'apr-1',
      decision: 'approve',
    });
    expect(plan).toMatchObject({
      kind: 'manual',
      command: 'pnpm kyberion approvals --approve apr-1',
    });
  });

  it('quotes a repository path with a single quote safely', () => {
    const plan = planApprovalWindow({
      ...base,
      repoRoot: "/Users/o'neil/kyberion",
      platform: 'darwin',
      requestId: 'apr-1',
      decision: 'approve',
    });
    if (plan.kind === 'launch')
      expect(plan.scriptBody).toContain("cd '/Users/o'\\''neil/kyberion'");
  });

  it.each(['../x', 'a b', 'id;rm', '', '$(x)'])('refuses an unsafe request id %j', (requestId) => {
    expect(() =>
      planApprovalWindow({ ...base, platform: 'darwin', requestId, decision: 'approve' })
    ).toThrow();
  });
});
