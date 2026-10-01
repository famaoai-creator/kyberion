import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import { pathResolver } from '@agent/core/path-resolver';
import { registerOpGuard, resetOpPreflight } from '@agent/core/pipeline/op-preflight';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/governance';
import { handleArtifactAction } from './artifact-actuator-helpers.js';
import { actuator } from './index.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('artifact-actuator', () => {
  it('emits artifact actions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'knowledge/product/schemas/artifact-action.schema.json')
    );
    const action = {
      action: 'write_json',
      params: {
        role: 'mission_controller',
        logicalPath: 'active/shared/runtime/artifacts/demo/demo-artifact.json',
        value: {
          artifact_id: 'ART-DEMO-1',
          kind: 'pptx',
          storage_class: 'artifact_store',
          created_at: '2026-04-26T00:00:00.000Z',
          evidence_refs: ['artifact:ART-DEMO-REF-1'],
        },
      },
    };
    const valid = validate(action);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('admits direct artifact actions only after the standard preflight', async () => {
    const dispose = registerOpGuard({
      id: `test:artifact-block-${process.pid}`,
      check: (call) =>
        call.op === 'artifact:write_json'
          ? { decision: 'block', reason: 'test artifact admission denial', terminate: true }
          : undefined,
    });
    try {
      await expect(
        handleArtifactAction({
          action: 'write_json',
          params: {
            role: 'mission_controller',
            logicalPath: 'active/shared/runtime/artifacts/test/blocked.json',
            value: {},
          },
        })
      ).rejects.toThrow('[OP_PREFLIGHT_BLOCK] test artifact admission denial');
    } finally {
      dispose();
      resetOpPreflight();
    }
  });

  it('ensure_dir creates the governed directory and requires logicalDir', async () => {
    // Own scratch root: other suites scan runtime/artifacts and expect only files there.
    const scratchRoot = `active/shared/runtime/artifact-actuator-test-${process.pid}`;
    const logicalDir = `${scratchRoot}/ensure`;
    try {
      const result = (await handleArtifactAction({
        action: 'ensure_dir',
        params: { role: 'mission_controller', logicalDir },
      })) as { status: string; path: string };
      expect(result.status).toBe('ensured');
      expect(result.path).toBe(pathResolver.rootResolve(logicalDir));
      expect(safeExistsSync(result.path)).toBe(true);
    } finally {
      withExecutionContext('mission_controller', () =>
        safeRmSync(pathResolver.rootResolve(scratchRoot), { recursive: true, force: true })
      );
    }
    await expect(
      handleArtifactAction({
        action: 'ensure_dir',
        params: { role: 'mission_controller', logicalDir: 'active/shared/tmp/not-governed' },
      })
    ).rejects.toThrow('outside governed');
    await expect(
      handleArtifactAction({
        action: 'ensure_dir',
        params: { role: 'mission_controller' },
      } as never)
    ).rejects.toThrow('logicalDir is required');
  });
});

describe('artifact-actuator SDK dispatch (pipeline / ADF path)', () => {
  it('reaches the action handler with { action: op, params }', async () => {
    const result = await actuator.dispatch('read_json', {
      role: 'mission_controller',
      logicalPath: 'active/shared/runtime/artifacts/test/never-written.json',
    });
    expect(result).toMatchObject({ ok: true, output: { status: 'ok', value: null } });
  });
});
