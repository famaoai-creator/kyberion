import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, pathResolver } from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('terminal-actuator schema', () => {
  it('accepts supported terminal actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/terminal-action.schema.json'));

    expect(
      validate({
        action: 'spawn',
        params: {
          shell: '/bin/zsh',
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);

    expect(
      validate({
        action: 'resize',
        params: {
          sessionId: 'pty-1',
          cols: 120,
          rows: 40,
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects unsupported terminal actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/terminal-action.schema.json'));

    expect(
      validate({
        action: 'unsupported',
        params: {},
      }),
    ).toBe(false);
  });
});
