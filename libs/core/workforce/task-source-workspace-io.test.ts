import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import * as first from './task-source-workspace-io.js';
import type { TaskToolBinding } from './task-tool-runtime.js';

describe('workspace IO capability across built/source module instances', () => {
  it('shares only issued windows and expires captured continuations after the sync callback', async () => {
    vi.resetModules();
    const second = await import('./task-source-workspace-io.js');
    const binding = {
      scope: { scope_kind: 'task', tier: 'personal', mission_id: 'MSN-IO', task_id: 'edit' },
      actorId: 'worker',
      workItemId: 'work',
      taskId: 'edit',
      missionId: 'MSN-IO',
      leaseId: 'lease',
      capabilityProfile: 'implementer',
      readRoots: [],
      writeRoots: [],
    } as TaskToolBinding;
    const relative = 'active/shared/runtime/workspaces/personal/shared/source/code.ts';
    const assertCurrent = vi.fn();
    let later: Promise<boolean> | undefined;
    first.withTaskSourceWorkspaceIo(
      binding,
      pathResolver.rootDir(),
      path.join(pathResolver.rootDir(), relative),
      true,
      assertCurrent,
      () => {
        expect(second.taskSourceWorkspaceIoActive()).toBe(true);
        expect(second.taskSourceWorkspaceIoAllowed(relative, 'write')).toBe(true);
        expect(second.taskSourceWorkspaceIoAllowed(relative + '.other', 'write')).toBe(false);
        later = Promise.resolve().then(() => second.taskSourceWorkspaceIoActive());
      }
    );
    expect(first.taskSourceWorkspaceIoActive()).toBe(false);
    expect(second.taskSourceWorkspaceIoActive()).toBe(false);
    expect(await later).toBe(false);
    expect(assertCurrent).toHaveBeenCalled();
  });
});
