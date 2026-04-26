import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('surface-policy schema', () => {
  it('accepts the governed legacy surface policy file', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/surface-policy.schema.json'));
    const policy = JSON.parse(
      safeReadFile(path.resolve(root, 'knowledge/public/governance/surface-policy.json'), {
        encoding: 'utf8',
      }) as string,
    );

    expect(validate(policy)).toBe(true);
  });

  it('rejects policies without provider routing', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/surface-policy.schema.json'));

    const invalid = {
      version: '1.0.0',
      routing: {
        text_routing: {
          greeting_patterns: [],
          receiver_rules: [],
        },
        compiled_flow_rules: [],
      },
    };

    expect(validate(invalid)).toBe(false);
  });
});
