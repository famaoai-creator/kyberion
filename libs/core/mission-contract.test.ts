import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from './schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('mission-contract schema', () => {
  it('accepts valid mission contracts', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/mission-contract.schema.json'));

    expect(
      validate({
        mission_id: 'msn-schema-1',
        tier: 'confidential',
        skill: 'design',
        action: 'extract_design_spec',
        role: 'mission_controller',
        static_params: {
          project_name: 'Schema Project',
        },
        safety_gate: {
          risk_level: 3,
          require_sudo: false,
          approved_by_sovereign: true,
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects invalid mission contracts', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/mission-contract.schema.json'));

    expect(
      validate({
        mission_id: 'Invalid Space',
        tier: 'confidential',
        skill: 'design',
      }),
    ).toBe(false);
  });
});
