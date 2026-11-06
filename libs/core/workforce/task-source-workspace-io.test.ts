import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import * as first from './task-source-workspace-io.js';
import * as window from '../foundation/task-source-workspace-capability.js';
import type { TaskToolBinding } from './task-tool-runtime.js';

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
const file = () => path.join(pathResolver.rootDir(), relative);
const open = <T>(writing: boolean, assertCurrent: () => void, run: () => T): T =>
  first.withTaskSourceWorkspaceIo(
    binding,
    pathResolver.rootDir(),
    file(),
    writing,
    assertCurrent,
    run
  );
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) safeRmSync(dir, { recursive: true, force: true });
});

describe('task source workspace window (private, opaque)', () => {
  it('is not honoured by a second module instance, in either direction (fail closed)', async () => {
    vi.resetModules();
    const second = await import('./task-source-workspace-io.js');
    const secondWindow = await import('../foundation/task-source-workspace-capability.js');
    expect(secondWindow.taskSourceWorkspaceGrantAllows).not.toBe(
      window.taskSourceWorkspaceGrantAllows
    );
    const assertCurrent = vi.fn();
    open(true, assertCurrent, () => {
      expect(first.taskSourceWorkspaceIoActive()).toBe(true);
      expect(window.taskSourceWorkspaceGrantAllows(relative, 'write')).toBe(true);
      expect(second.taskSourceWorkspaceIoActive()).toBe(false);
      expect(secondWindow.taskSourceWorkspaceGrantAllows(relative, 'write')).toBe(false);
      expect(secondWindow.taskSourceWorkspaceGrantAllows(relative, 'read')).toBe(false);
    });
    second.withTaskSourceWorkspaceIo(binding, pathResolver.rootDir(), file(), true, vi.fn(), () => {
      expect(secondWindow.taskSourceWorkspaceGrantAllows(relative, 'write')).toBe(true);
      expect(first.taskSourceWorkspaceIoActive()).toBe(false);
      expect(window.taskSourceWorkspaceGrantAllows(relative, 'write')).toBe(false);
      expect(window.taskSourceWorkspaceIoDenial(relative + '.other', 'write')).toBeNull();
    });
    expect(assertCurrent).toHaveBeenCalled();
  });

  it('authorizes only the exact target inside its physical partition', () => {
    open(true, vi.fn(), () => {
      expect(window.taskSourceWorkspaceGrantAllows(relative, 'write')).toBe(true);
      expect(window.taskSourceWorkspaceGrantAllows(relative, 'read')).toBe(true);
      expect(window.taskSourceWorkspaceGrantAllows(relative + '.other', 'write')).toBe(false);
      expect(window.taskSourceWorkspaceGrantAllows(relative, 'append')).toBe(false);
      expect(
        window.taskSourceWorkspaceGrantAllows(
          'active/shared/runtime/workspaces/personal/shared/source',
          'mkdir'
        )
      ).toBe(true);
      // Ancestors outside the partition and product knowledge pass the narrowing but
      // are not authorized by the window: the caller's own policy decides them.
      for (const outside of [
        'active/shared/runtime/workspaces/personal/shared',
        'active/shared/runtime/workspaces',
        'active/shared',
      ]) {
        expect(window.taskSourceWorkspaceIoDenial(outside, 'mkdir')).toBeNull();
        expect(window.taskSourceWorkspaceGrantAllows(outside, 'mkdir')).toBe(false);
      }
      expect(
        window.taskSourceWorkspaceIoDenial('knowledge/product/governance/x.json', 'read')
      ).toBeNull();
      expect(
        window.taskSourceWorkspaceGrantAllows('knowledge/product/governance/x.json', 'read')
      ).toBe(false);
      expect(
        window.taskSourceWorkspaceIoDenial(
          'active/shared/runtime/workspaces/personal/shared/source/other.ts',
          'read'
        )
      ).toMatch('TASK_SOURCE_SCOPE_DENIED');
    });
    open(false, vi.fn(), () => {
      expect(window.taskSourceWorkspaceGrantAllows(relative, 'read')).toBe(true);
      expect(window.taskSourceWorkspaceGrantAllows(relative, 'write')).toBe(false);
      expect(window.taskSourceWorkspaceIoDenial(relative, 'write')).toMatch(
        'TASK_SOURCE_SCOPE_DENIED'
      );
    });
    expect(window.taskSourceWorkspaceGrantAllows(relative, 'read')).toBe(false);
    expect(window.taskSourceWorkspaceIoDenial(relative + '.other', 'write')).toBeNull();
  });

  it('refuses a window outside an exact private workspace partition', () => {
    const issue = (input: Partial<window.TaskSourceWorkspaceWindow>) => () =>
      window.withTaskSourceWorkspaceCapability(
        { target: relative, writing: true, tier: 'personal', tenant: 'shared', ...input },
        vi.fn(),
        () => undefined
      );
    expect(issue({})).not.toThrow();
    for (const input of [
      { tier: 'public' as never },
      { tenant: 'acme' },
      { tenant: '../shared' },
      { target: 'active/shared/runtime/workspaces/personal/shared/' },
      { target: 'active/shared/runtime/workspaces/personal/shared/a/../../acme/x.ts' },
      { target: 'active/shared/runtime/workspaces/personal/shared//x.ts' },
      { target: 'knowledge/personal/x.ts' },
      { writing: 'yes' as never },
    ])
      expect(issue(input), JSON.stringify(input)).toThrow('TASK_SOURCE_SCOPE_DENIED');
    expect(() =>
      first.withTaskSourceWorkspaceIo(
        { ...binding, scope: { ...binding.scope, tier: 'public' } } as TaskToolBinding,
        pathResolver.rootDir(),
        file(),
        true,
        vi.fn(),
        () => undefined
      )
    ).toThrow('TASK_SOURCE_SCOPE_DENIED');
  });

  it('cannot be forged through the former shared registry or an outside AsyncLocalStorage', () => {
    const forged = Object.freeze({
      target: relative,
      writing: true,
      tier: 'personal',
      tenant: 'shared',
      partition: 'active/shared/runtime/workspaces/personal/shared/',
      assertCurrent: () => undefined,
    });
    const access = new AsyncLocalStorage<typeof forged>();
    const key = Symbol.for('kyberion.core.task-source-workspace-io.v1');
    const global = globalThis as Record<symbol, unknown>;
    const previous = global[key];
    global[key] = { access, issued: new WeakSet([forged]) };
    try {
      access.run(forged, () => {
        expect(first.taskSourceWorkspaceIoActive()).toBe(false);
        expect(window.taskSourceWorkspaceGrantAllows(relative, 'write')).toBe(false);
      });
    } finally {
      if (previous === undefined) delete global[key];
      else global[key] = previous;
    }
    // Nothing but the issuer and the predicates leaves the module.
    expect(Object.keys(window).sort()).toEqual([
      'taskSourceWorkspaceGrantAllows',
      'taskSourceWorkspaceIoActive',
      'taskSourceWorkspaceIoDenial',
      'withTaskSourceWorkspaceCapability',
    ]);
  });

  it('is synchronous: continuations and async callbacks never hold it', async () => {
    let later: Promise<boolean> | undefined;
    open(true, vi.fn(), () => {
      later = Promise.resolve().then(() =>
        window.taskSourceWorkspaceGrantAllows(relative, 'write')
      );
    });
    expect(await later).toBe(false);
    let inside: Promise<boolean> | undefined;
    expect(() =>
      open(true, vi.fn(), () => {
        inside = (async () => {
          await Promise.resolve();
          return window.taskSourceWorkspaceGrantAllows(relative, 'write');
        })();
        return inside;
      })
    ).toThrow('synchronous only');
    expect(await inside).toBe(false);
    expect(first.taskSourceWorkspaceIoActive()).toBe(false);
  });

  it('runs liveness as the caller with the window suspended, and a stale claim still blocks', () => {
    const dir = pathResolver.sharedTmp(`task-source-window-test/${randomUUID()}`);
    scratch.push(dir);
    safeMkdir(dir, { recursive: true });
    const ledger = path.join(dir, 'ledger.json');
    safeWriteFile(ledger, '{"current":true}');
    let current = true;
    const reads: string[] = [];
    // Liveness reads a ledger outside the window, as task-tool-runtime and the
    // task source edit grant do (work-coordination and workspace ledgers).
    const assertCurrent = () => {
      reads.push(String(safeReadFile(ledger, { encoding: 'utf8' })));
      if (!current) throw new Error('[TASK_TOOL_LEASE_LOST] Task claim is no longer current');
    };
    open(true, assertCurrent, () => {
      const before = reads.length;
      expect(first.taskSourceWorkspaceIoActive()).toBe(true);
      expect(window.taskSourceWorkspaceGrantAllows(relative, 'write')).toBe(true);
      expect(reads.length).toBeGreaterThan(before);
      // The same read made by the window's own I/O is narrowed to the window.
      expect(() => safeReadFile(ledger, { encoding: 'utf8' })).toThrow('TASK_SOURCE_SCOPE_DENIED');
      current = false;
      expect(() => first.taskSourceWorkspaceIoActive()).toThrow('TASK_TOOL_LEASE_LOST');
      expect(() => window.taskSourceWorkspaceGrantAllows(relative, 'write')).toThrow(
        'TASK_TOOL_LEASE_LOST'
      );
      expect(() => window.taskSourceWorkspaceIoDenial(relative, 'write')).toThrow(
        'TASK_TOOL_LEASE_LOST'
      );
    });
    expect(() => open(true, assertCurrent, () => undefined)).toThrow('TASK_TOOL_LEASE_LOST');
  });
});
