import { describe, expect, it, vi } from 'vitest';

vi.mock('./daemon_watchdog.js', () => ({ DEFAULT_DAEMONS: ['watchdog-daemon'] }));

import { runDotLifecycleWorker } from './dot_lifecycle_worker.js';

const EXPECT = [
  '--expect-status',
  'active',
  '--expect-admission-hash',
  'a'.repeat(64),
  '--expect-scope-json',
  '{"tier":"public"}',
];

describe('dot lifecycle worker', () => {
  it('passes every expectation to the locked transition', () => {
    const transition = vi.fn((dotId: string, status: string) => ({ dot_id: dotId, status }));
    const result = runDotLifecycleWorker(
      ['pause', 'dot-a', ...EXPECT, '--actor', 'human:owner'],
      transition as never
    );
    expect(result).toEqual({ ok: true, dot_id: 'dot-a', action: 'pause', status: 'paused' });
    expect(transition).toHaveBeenCalledWith('dot-a', 'paused', {
      supervisedDaemonIds: ['watchdog-daemon'],
      expectedStatus: 'active',
      expectedAdmissionScopeHash: 'a'.repeat(64),
      expectedScope: { tier: 'public' },
      actor: 'human:owner',
    });
    runDotLifecycleWorker(['resume', 'dot-a', ...EXPECT], transition as never);
    expect(transition).toHaveBeenLastCalledWith('dot-a', 'active', expect.any(Object));
  });

  it('fails closed without the expectations or with an unknown action', () => {
    const transition = vi.fn();
    expect(() => runDotLifecycleWorker(['pause', 'dot-a'], transition as never)).toThrow(
      /requires --expect-status/
    );
    expect(() =>
      runDotLifecycleWorker(['pause', 'dot-a', '--expect-status', 'active'], transition as never)
    ).toThrow(/DOT_TRANSITION_EXPECTATION/);
    expect(() =>
      runDotLifecycleWorker(['retire', 'dot-a', ...EXPECT], transition as never)
    ).toThrow(/usage/);
    expect(transition).not.toHaveBeenCalled();
  });
});

describe('dot lifecycle worker round trip (real charter lock)', () => {
  const ROOT = 'active/shared/tmp/dot-lifecycle-worker-tests';
  const CHARTER = {
    kind: 'dot-charter',
    dot_id: 'worker-roundtrip',
    version: '1.0.0',
    title: 'Worker round trip',
    purpose: 'test',
    status: 'active',
    scope: { tier: 'public' },
    goal: { statement: 'test' },
    attention: { triggers: [{ kind: 'wake', channels: ['inbox'] }] },
    authority: { authority_role: 'infrastructure_sentinel' },
    notification: { deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { heartbeat_id: 'dot-worker-roundtrip' },
  };

  it('pauses, refuses a stale replay, and resumes', async () => {
    const { safeMkdir, safeRmSync, safeWriteFile } = await import('@agent/core/secure-io');
    const { transitionDotCharterStatus } = await import('@agent/core/dot/dot-lifecycle');
    const { findDotCharter } = await import('@agent/core/dot/dot-charter');
    const { dotAdmissionScopeHash } = await import('@agent/core/dot/dot-admission-identity');
    safeMkdir(`${ROOT}/dots`, { recursive: true });
    try {
      safeWriteFile(`${ROOT}/dots/worker-roundtrip.json`, JSON.stringify(CHARTER));
      const transition = ((id, target, deps) =>
        transitionDotCharterStatus(id, target, {
          ...deps,
          rootDir: ROOT,
          hasRole: () => true,
        })) as typeof transitionDotCharterStatus;
      const hash = dotAdmissionScopeHash(CHARTER as never);
      const scope = JSON.stringify(CHARTER.scope);
      const args = (action: string, status: string) => [
        action,
        CHARTER.dot_id,
        '--expect-status',
        status,
        '--expect-admission-hash',
        hash,
        '--expect-scope-json',
        scope,
      ];
      expect(runDotLifecycleWorker(args('pause', 'active'), transition).status).toBe('paused');
      // The same request replayed after the change fails closed, nothing written.
      expect(() => runDotLifecycleWorker(args('pause', 'active'), transition)).toThrow(
        /DOT_TRANSITION_CONFLICT|DOT_TRANSITION|not allowed|invalid transition/i
      );
      expect(findDotCharter(CHARTER.dot_id, ROOT)?.charter.status).toBe('paused');
      expect(runDotLifecycleWorker(args('resume', 'paused'), transition).status).toBe('active');
      expect(findDotCharter(CHARTER.dot_id, ROOT)?.charter.status).toBe('active');
    } finally {
      safeRmSync(ROOT, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('dot lifecycle worker under its own system role (L1)', () => {
  const ROOT = 'active/shared/tmp/dot-lifecycle-worker-role-tests';

  it('activates a draft as SYSTEM_ROLE=dot_lifecycle_worker without any other role', async () => {
    const { safeMkdir, safeRmSync, safeWriteFile } = await import('@agent/core/secure-io');
    const { transitionDotCharterStatus } = await import('@agent/core/dot/dot-lifecycle');
    const { findDotCharter } = await import('@agent/core/dot/dot-charter');
    const { dotAdmissionScopeHash } = await import('@agent/core/dot/dot-admission-identity');
    const { loadAuthorityRoleIndex } =
      await import('@agent/core/organization/authority-role-registry');
    safeMkdir(`${ROOT}/dots`, { recursive: true });
    const charter = {
      kind: 'dot-charter',
      dot_id: 'worker-activate',
      version: '1.0.0',
      title: 'Worker activate',
      purpose: 'test',
      status: 'draft',
      scope: { tier: 'public' },
      goal: { statement: 'test' },
      attention: { triggers: [{ kind: 'wake', channels: ['inbox'] }] },
      authority: { authority_role: 'infrastructure_sentinel' },
      notification: { deliver_to: { surface: 'surface', channel: 'inbox' } },
      runtime: { heartbeat_id: 'dot-worker-activate' },
    };
    safeWriteFile(`${ROOT}/dots/worker-activate.json`, JSON.stringify(charter));
    vi.stubEnv('SYSTEM_ROLE', 'dot_lifecycle_worker');
    vi.stubEnv('KYBERION_BASE_ROLE', 'worker');
    vi.stubEnv('MISSION_ROLE', '');
    try {
      // The activation gate reads the canonical role registry (repo root) and
      // lists charters, then writes under the dot lifecycle store roles — every step
      // runs under the worker's system role, so a missing grant would throw
      // [ROLE_ASSUMPTION_DENIED] here.
      const registry = loadAuthorityRoleIndex();
      expect(registry.infrastructure_sentinel).toBeDefined();
      const transition = ((id, target, deps) =>
        transitionDotCharterStatus(id, target, {
          ...deps,
          rootDir: ROOT,
          hasRole: (role: string) => Boolean(registry[role]),
        })) as typeof transitionDotCharterStatus;
      const result = runDotLifecycleWorker(
        [
          'activate',
          charter.dot_id,
          '--expect-status',
          'draft',
          '--expect-admission-hash',
          dotAdmissionScopeHash(charter as never),
          '--expect-scope-json',
          JSON.stringify(charter.scope),
        ],
        transition
      );
      expect(result.status).toBe('active');
      expect(findDotCharter(charter.dot_id, ROOT)?.charter.status).toBe('active');
      // The Kyberion server's own role can never perform the same write.
      vi.stubEnv('SYSTEM_ROLE', 'concierge');
      expect(() =>
        runDotLifecycleWorker(
          [
            'pause',
            charter.dot_id,
            '--expect-status',
            'active',
            '--expect-admission-hash',
            dotAdmissionScopeHash(charter as never),
            '--expect-scope-json',
            JSON.stringify(charter.scope),
          ],
          transition
        )
      ).toThrow(/ROLE_ASSUMPTION_DENIED/);
      expect(findDotCharter(charter.dot_id, ROOT)?.charter.status).toBe('active');
    } finally {
      vi.unstubAllEnvs();
      safeRmSync(ROOT, { recursive: true, force: true });
    }
  }, 60_000);
});
