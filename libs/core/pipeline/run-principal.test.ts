import { beforeEach, describe, expect, it, vi } from 'vitest';

let resolveMember: (...args: unknown[]) => unknown = () => null;
const calls: unknown[][] = [];
vi.mock('../organization/member-registry.js', () => ({
  resolveMemberByPrincipal: (...args: unknown[]) => {
    calls.push(args);
    return resolveMember(...args);
  },
}));

import { principalForAccountable, resolveRunPrincipal } from './run-principal.js';

describe('resolveRunPrincipal', () => {
  beforeEach(() => {
    calls.length = 0;
    resolveMember = () => ({ member_id: 'owner', status: 'active' });
  });

  it('attends a present terminal that resolves to the active owner', () => {
    expect(resolveRunPrincipal({ hasHuman: true, env: {} })).toEqual({
      mode: 'attended',
      memberId: 'owner',
      reason: 'terminal + active member',
    });
    expect(calls).toEqual([[{ source: 'loopback' }, {}]]);
  });

  it('keeps a terminal without an active member unattended', () => {
    resolveMember = () => null;
    expect(resolveRunPrincipal({ hasHuman: true, env: {} }).mode).toBe('unattended');
  });

  it('fails closed when the member registry cannot be read', () => {
    resolveMember = () => {
      throw new Error('corrupt profile');
    };
    expect(resolveRunPrincipal({ hasHuman: true, env: {} }).mode).toBe('unattended');
  });

  it.each([false, undefined])('never attends without terminal presence (%s)', (hasHuman) => {
    expect(resolveRunPrincipal({ hasHuman, env: {} }).mode).toBe('unattended');
    expect(calls).toEqual([]);
  });

  it.each([
    [{ CLAUDECODE: '1' }],
    [{ KYBERION_RUN_ORIGIN: 'agent' }],
    [{ KYBERION_AGENT_ID: 'planner' }],
  ])('never attends an agent-driven process, even with hasHuman: true (%o)', (env) => {
    const principal = resolveRunPrincipal({ hasHuman: true, env });
    expect(principal.mode).toBe('unattended');
    expect(principal.reason).toMatch(/^agent-driven process/);
    expect(calls).toEqual([]);
  });
});

describe('principalForAccountable', () => {
  const attended = {
    mode: 'attended' as const,
    memberId: 'alice',
    reason: 'terminal + active member',
  };

  it('keeps attended only for the accountable human or a declared deputy', () => {
    expect(principalForAccountable(attended, { actor: 'user:alice', deputies: [] })).toBe(attended);
    expect(principalForAccountable(attended, { actor: 'user:bob', deputies: ['user:alice'] })).toBe(
      attended
    );
  });

  it('runs another terminal member unattended', () => {
    const principal = principalForAccountable(attended, { actor: 'user:bob', deputies: [] });
    expect(principal.mode).toBe('unattended');
    expect(principal.reason).toContain('not the approving owner');
  });
});
