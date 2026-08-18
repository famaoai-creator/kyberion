import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  compileSchemaFromPath,
  pathResolver,
  registerOpGuard,
  resetOpPreflight,
} from '@agent/core';
import { handleArtifactAction } from './artifact-actuator-helpers.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('artifact-actuator', () => {
  it('emits artifact actions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'schemas/artifact-action.schema.json')
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
});
