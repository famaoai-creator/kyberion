import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath, pathResolver } from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('artifact-actuator', () => {
  it('emits artifact actions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/artifact-action.schema.json'));
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
});
