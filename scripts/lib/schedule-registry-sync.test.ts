import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { safeMkdir, safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertChronosPipelinePath,
  collectPersonalPipelineFiles,
  resolvePersonalRuntimeEnv,
} from '../chronos_daemon.js';
import { syncScheduleRegistry, type ScheduleScope } from './schedule-registry-sync.js';

const REGISTRY_REL = 'active/shared/runtime/pipeline-schedules.json';

describe('syncScheduleRegistry — personal scope', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function fixtureRoot(): string {
    const root = fs.mkdtempSync(path.join(pathResolver.sharedTmp(''), 'sched-sync-'));
    roots.push(root);
    safeMkdir(path.join(root, 'pipelines'), { recursive: true });
    safeWriteFile(
      path.join(root, 'pipelines', 'repo-job.json'),
      JSON.stringify({
        name: 'repo job',
        schedule: { id: 'repo-job', cron: '0 3 * * *', enabled: true },
        context: { from_repo: true },
        steps: [{ id: 's1', op: 'system:log', params: { message: 'x' } }],
      })
    );
    const personalDir = path.join(root, 'knowledge', 'personal', 'pipelines');
    safeMkdir(personalDir, { recursive: true });
    safeWriteFile(
      path.join(personalDir, 'daily-routine.json'),
      JSON.stringify({
        name: 'daily routine',
        schedule: { id: 'daily-routine', cron: '0 6 * * *', enabled: true },
        // Operator-local bindings must never land in the shared registry.
        context: { operator_note: 'private' },
        steps: [{ id: 's1', op: 'system:log', params: { message: 'x' } }],
      })
    );
    return root;
  }

  function deps(root: string) {
    return {
      rootDir: root,
      collectTenantPipelineFiles: () => [] as Array<{ tenant_slug: string; file: string }>,
      collectPersonalPipelineFiles,
      readScheduledPipelineAdf: (fullPath: string) => {
        const scope = assertChronosPipelinePath(fullPath, root) as ScheduleScope;
        const adf = JSON.parse(String(safeReadFile(fullPath, { encoding: 'utf8' })));
        return { scope, adf };
      },
      assertTenantRuntime: () => {},
      assertPersonalRuntime: (
        scope: Extract<ScheduleScope, { kind: 'personal' }>,
        runtime: unknown
      ) =>
        // The daemon's scope carries `relative`; the sync-level type does not.
        resolvePersonalRuntimeEnv(scope as { kind: 'personal'; relative: string }, runtime, root),
    };
  }

  it('namespaces personal ids and strips scoped context', () => {
    const root = fixtureRoot();
    const result = syncScheduleRegistry(deps(root));
    expect(result.desired).toBe(2);
    expect(result.added).toBe(2);
    expect(result.skipped).toEqual([]);

    const registry = JSON.parse(
      String(safeReadFile(path.join(root, REGISTRY_REL), { encoding: 'utf8' }))
    ) as { schedules: Array<Record<string, any>> };
    const byId = new Map(registry.schedules.map((s) => [s.id, s]));

    const personal = byId.get('personal-daily-routine');
    expect(personal).toBeDefined();
    expect(personal?.context).toEqual({});
    expect(personal?.enabled).toBe(true);
    expect(personal?.optIn).toBe(false);
    expect(String(personal?.pipelinePath)).toContain(
      'knowledge/personal/pipelines/daily-routine.json'
    );

    const repo = byId.get('repo-job');
    expect(repo?.context).toEqual({ from_repo: true });
    // A personal file can never shadow the repository id space.
    expect(byId.has('daily-routine')).toBe(false);
  });

  it('skips a personal pipeline whose runtime needs exceed the personal allowlist', () => {
    const root = fixtureRoot();
    safeWriteFile(
      path.join(root, 'knowledge', 'personal', 'pipelines', 'needs-scope.json'),
      JSON.stringify({
        name: 'needs scope',
        schedule: { id: 'needs-scope', cron: '0 8 * * *', enabled: true },
        runtime: { authorized_scope: ['confluence'] },
        steps: [{ id: 's1', op: 'system:log', params: { message: 'x' } }],
      })
    );
    const result = syncScheduleRegistry(deps(root));
    // Deny-by-default: no allowlist file -> the pipeline is skipped, not scheduled.
    expect(result.skipped).toEqual([
      expect.objectContaining({
        file: 'knowledge/personal/pipelines/needs-scope.json',
        reason: expect.stringContaining('pipeline-runtime-allowlist.json'),
      }),
    ]);
    const registry = JSON.parse(
      String(safeReadFile(path.join(root, REGISTRY_REL), { encoding: 'utf8' }))
    ) as { schedules: Array<Record<string, any>> };
    expect(registry.schedules.some((s) => s.id === 'personal-needs-scope')).toBe(false);
  });
});
