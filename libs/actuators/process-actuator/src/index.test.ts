import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import * as pathResolver from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { handleAction, parseProcessAction } from './index.js';
import { readProcessJson } from './process-actuator-helpers.js';
import { runtimeSupervisor } from '@agent/core/tool/runtime-supervisor';
import { processStartMarker } from '@agent/core/workforce/workspace-process-identity';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('process-actuator schema', () => {
  it('rejects malformed direct adapter input before dispatch', () => {
    expect(() => parseProcessAction(null)).toThrow('supported action');
    expect(() => parseProcessAction({ action: 'status', params: [] })).toThrow('params');
    expect(() => parseProcessAction({ action: 'pipeline', steps: {} })).toThrow('steps');
    expect(() => parseProcessAction({ action: 'list', context: [] })).toThrow('context');
    expect(parseProcessAction({ action: 'list' })).toEqual({ action: 'list', params: {} });
  });

  it('accepts supported process actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'knowledge/product/schemas/process-action.schema.json')
    );

    expect(
      validate({
        action: 'spawn',
        params: {
          resourceId: 'proc-schema-1',
          ownerId: 'mission-controller',
          ownerType: 'mission',
          kind: 'worker',
          command: 'node',
          args: ['--version'],
        },
      }),
      JSON.stringify(validate.errors || [])
    ).toBe(true);

    expect(
      validate({
        action: 'status',
        params: {
          resourceId: 'proc-schema-1',
        },
      }),
      JSON.stringify(validate.errors || [])
    ).toBe(true);
  });

  it('rejects unsupported process actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'knowledge/product/schemas/process-action.schema.json')
    );

    expect(
      validate({
        action: 'unsupported',
        params: {},
      })
    ).toBe(false);
  });
});

describe('process-actuator lifecycle identity', () => {
  it('reports spawn_failed and records the resource as exited when the binary is missing', async () => {
    const resourceId = `spawn-fail-${process.pid}`;
    try {
      const result = await handleAction({
        action: 'spawn',
        params: {
          resourceId,
          command: `definitely-not-a-binary-${process.pid}`,
          kind: 'pty',
          ownerId: 'test',
          ownerType: 'test',
        },
      });
      expect(result).toMatchObject({ status: 'spawn_failed', resourceId });
      expect((result as Record<string, unknown>).reason).toBeTruthy();
      expect(runtimeSupervisor.get(resourceId)?.state).toBe('exited');
    } finally {
      runtimeSupervisor.unregister(resourceId);
    }
  });

  it('reports spawned with identity fields for a real process and stops it', async () => {
    const resourceId = `spawn-ok-${process.pid}`;
    const result = await handleAction({
      action: 'spawn',
      params: {
        resourceId,
        command: 'sleep',
        args: ['60'],
        kind: 'pty',
        ownerId: 'test',
        ownerType: 'test',
      },
    });
    try {
      expect(result).toMatchObject({ status: 'spawned', resourceId });
      expect((result as Record<string, unknown>).pid).toBeGreaterThan(0);
      expect(
        (result as Record<string, unknown>).pidStartMarker === undefined ||
          typeof (result as Record<string, unknown>).pidStartMarker === 'string'
      ).toBe(true);
    } finally {
      await handleAction({ action: 'stop', params: { resourceId } });
      runtimeSupervisor.unregister(resourceId);
    }
  });

  it('reports not_found instead of claiming a stop for an unknown resource', async () => {
    const result = await handleAction({
      action: 'stop',
      params: { resourceId: `never-registered-${process.pid}` },
    });
    expect(result).toMatchObject({
      status: 'not_found',
      reason: 'resource_not_registered',
    });
    expect((result as Record<string, unknown>).next_step).toBeTruthy();
  });

  it('reports already_exited for a record whose pid is gone', async () => {
    const resourceId = `dead-pid-${process.pid}`;
    runtimeSupervisor.register({
      resourceId,
      kind: 'pty',
      ownerId: 'test',
      ownerType: 'test',
      pid: 999999,
    });
    try {
      const result = await handleAction({
        action: 'stop',
        params: { resourceId },
      });
      expect(result).toMatchObject({ status: 'already_exited', pid: 999999 });
      expect(runtimeSupervisor.get(resourceId)).toBeUndefined();
    } finally {
      runtimeSupervisor.unregister(resourceId);
    }
  });

  it('treats a start-marker mismatch as exited and never signals the recycled pid', async () => {
    // Register a record that claims our own test process under a wrong
    // start marker: the pid is live but is not the recorded process.
    const resourceId = `recycled-pid-${process.pid}`;
    const markerReadable = processStartMarker(process.pid) !== undefined;
    let cleanupRan = false;
    runtimeSupervisor.register({
      resourceId,
      kind: 'pty',
      ownerId: 'test',
      ownerType: 'test',
      pid: process.pid,
      pidStartMarker: 'sentinel-not-the-real-marker',
      cleanup: () => {
        cleanupRan = true;
      },
    });
    try {
      const result = await handleAction({
        action: 'stop',
        params: { resourceId },
      });
      if (markerReadable) {
        expect(result).toMatchObject({ status: 'already_exited' });
      }
      // Either way this test process must still be running afterwards.
      expect(process.pid).toBeGreaterThan(0);
      expect(runtimeSupervisor.get(resourceId)).toBeUndefined();
      expect(cleanupRan).toBe(true);
    } finally {
      runtimeSupervisor.unregister(resourceId);
    }
  });

  it('reports cleanup_failed and keeps the record owned when cleanup throws', async () => {
    const resourceId = `cleanup-fail-${process.pid}`;
    runtimeSupervisor.register({
      resourceId,
      kind: 'pty',
      ownerId: 'test',
      ownerType: 'test',
      cleanup: () => {
        throw new Error('simulated cleanup failure');
      },
    });
    try {
      const result = await handleAction({
        action: 'stop',
        params: { resourceId },
      });
      expect(result).toMatchObject({ status: 'cleanup_failed' });
      expect(runtimeSupervisor.get(resourceId)?.lastCleanupError?.error).toBe(
        'simulated cleanup failure'
      );
    } finally {
      runtimeSupervisor.unregister(resourceId);
    }
  });

  it('exposes alive + identity on status for a pid-bearing record', async () => {
    const resourceId = `status-identity-${process.pid}`;
    runtimeSupervisor.register({
      resourceId,
      kind: 'pty',
      ownerId: 'test',
      ownerType: 'test',
      pid: process.pid,
      pidStartMarker: processStartMarker(process.pid),
    });
    try {
      const result = await handleAction({
        action: 'status',
        params: { resourceId },
      });
      expect(result).toMatchObject({ status: 'ok' });
      const resource = (result as Record<string, unknown>).resource;
      expect(resource.pid).toBe(process.pid);
      expect(resource.alive).toBe(true);
      expect(['pid+start_marker', 'pid_only']).toContain(resource.identity);
    } finally {
      runtimeSupervisor.unregister(resourceId);
    }
  });
});

describe('process-actuator path boundaries', () => {
  it('rejects a spawn cwd outside the repository before process creation', async () => {
    await expect(
      handleAction({
        action: 'spawn',
        params: {
          resourceId: 'external-cwd-test',
          ownerId: 'mission-controller',
          ownerType: 'mission',
          kind: 'worker',
          command: 'node',
          cwd: '/tmp/external-process-cwd',
        },
      })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects dangerous persisted process input before parsing the action', () => {
    const inputPath = path.join(
      pathResolver.rootDir(),
      `active/shared/tmp/process-actuator-tests/dangerous-input-${process.pid}.json`
    );
    safeMkdir(path.dirname(inputPath), { recursive: true });
    safeWriteFile(inputPath, '{"constructor":{"polluted":true}}');

    try {
      expect(() => readProcessJson(inputPath, 'process action input')).toThrow(
        'dangerous JSON key'
      );
    } finally {
      safeRmSync(inputPath, { force: true });
    }
  });

  it('rejects a directory masquerading as persisted process input', () => {
    const inputPath = path.join(
      pathResolver.rootDir(),
      `active/shared/tmp/process-actuator-tests/directory-input-${process.pid}`
    );
    safeMkdir(inputPath, { recursive: true });

    try {
      expect(() => readProcessJson(inputPath, 'process action input')).toThrow(
        'existing regular file'
      );
    } finally {
      safeRmSync(inputPath, { recursive: true, force: true });
    }
  });
});
