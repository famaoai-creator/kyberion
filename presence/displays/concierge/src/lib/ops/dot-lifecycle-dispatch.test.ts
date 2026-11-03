import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { safeReadFile } from '@agent/core/secure-io';
import {
  DOT_LIFECYCLE_WORKER_SCRIPT,
  DotLifecycleDispatchError,
  dispatchDotLifecycleWorker,
} from './dot-lifecycle-dispatch';

const PLAN = {
  dot_id: 'ops-dot',
  action: 'pause' as const,
  target: 'paused' as const,
  expectedStatus: 'active' as const,
  expectedScope: { tier: 'confidential' as const, tenant_slug: 'acme' },
  expectedAdmissionScopeHash: 'h'.repeat(64),
};

describe('dot lifecycle worker dispatch (D3)', () => {
  it('launches the governed worker under its own system role with every expectation', async () => {
    const calls: Array<{ args: string[]; env: Record<string, unknown> }> = [];
    const audits: unknown[] = [];
    const result = await dispatchDotLifecycleWorker(PLAN, 'human:owner', {
      run: async (_command, args, options) => {
        calls.push({ args, env: options.env });
        return {
          stdout: '{"ok":true,"dot_id":"ops-dot","status":"paused"}',
          stderr: '',
          status: 0,
        };
      },
      audit: (entry) => audits.push(entry),
    });
    expect(result).toEqual({ dot_id: 'ops-dot', status: 'paused' });
    expect(calls[0]!.args).toEqual([
      DOT_LIFECYCLE_WORKER_SCRIPT,
      'pause',
      'ops-dot',
      '--expect-status',
      'active',
      '--expect-admission-hash',
      'h'.repeat(64),
      '--expect-scope-json',
      JSON.stringify(PLAN.expectedScope),
      '--actor',
      'human:owner',
      '--json',
    ]);
    expect(calls[0]!.env).toMatchObject({
      SYSTEM_ROLE: 'dot_lifecycle_worker',
      KYBERION_DELEGATED_ROLE: '',
      MISSION_ROLE: '',
    });
    expect(audits).toEqual([
      { action: 'pause', dotId: 'ops-dot', actor: 'human:owner', result: 'completed' },
    ]);
  });

  it('maps a worker-side re-validation failure to a conflict and audits it', async () => {
    const audits: Array<{ result: string }> = [];
    const failure = dispatchDotLifecycleWorker(PLAN, undefined, {
      run: async () => ({
        stdout: '',
        stderr: '[DOT_TRANSITION_CONFLICT] Charter changed; refresh before controlling it.',
        status: 1,
      }),
      audit: (entry) => audits.push(entry),
    });
    await expect(failure).rejects.toMatchObject({ conflict: true });
    await expect(failure).rejects.toBeInstanceOf(DotLifecycleDispatchError);
    expect(audits[0]).toMatchObject({ result: 'failed' });
  });

  it('refuses an unconfirmed worker result', async () => {
    await expect(
      dispatchDotLifecycleWorker(PLAN, undefined, {
        run: async () => ({
          stdout: '{"ok":true,"dot_id":"other","status":"paused"}',
          stderr: '',
          status: 0,
        }),
        audit: () => undefined,
      })
    ).rejects.toMatchObject({ conflict: false });
  });

  it('keeps the lifecycle writer out of the server process', () => {
    const route = String(
      safeReadFile(
        fileURLToPath(new URL('../../app/api/ops/workspace/autonomy/route.ts', import.meta.url)),
        { encoding: 'utf8' }
      )
    );
    expect(route).toContain('planWorkspaceAutonomyControl');
    expect(route).toContain('dispatchDotLifecycleWorker');
    expect(route).not.toContain('controlWorkspaceAutonomy');
    expect(route).not.toContain('@agent/core/dot/dot-lifecycle');
  });
});
