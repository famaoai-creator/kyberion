import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from './schema-loader.js';
import { buildComputerSurfaceMessages } from './computer-surface.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('computer-surface a2ui messages', () => {
  it('emits A2UI messages that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true, validateSchema: false });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/a2ui-message.schema.json'));

    const messages = buildComputerSurfaceMessages({
      sessionId: 'session-schema-1',
      executor: 'terminal',
      status: 'running',
      latestAction: 'spawn',
      target: 'terminal',
      actionCount: 1,
    });

    for (const message of messages) {
      expect(validate(message), JSON.stringify(validate.errors || [])).toBe(true);
    }
  });

  it('rejects malformed A2UI messages', () => {
    const ajv = new Ajv({ allErrors: true, validateSchema: false });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/a2ui-message.schema.json'));

    expect(
      validate({
        createSurface: {
          catalogId: 'computer-surface',
        },
      }),
    ).toBe(false);
  });
});
