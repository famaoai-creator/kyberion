import AjvModule from 'ajv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileSchema } from './foundation/ajv.js';
import { compileSchemaFromPath } from './schema-loader.js';

const Ajv = (AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule;

describe('schema-loader compatibility boundary', () => {
  const schemaPath = path.resolve(process.cwd(), 'schemas/video-composition-action.schema.json');
  const validRequest = { action: 'list_video_composition_templates', params: {} };

  it('delegates legacy compilation to the caller-owned Ajv instance', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = compileSchemaFromPath(ajv, schemaPath);

    expect(validate(validRequest)).toBe(true);
    expect(ajv.getSchema(pathToFileURL(schemaPath).href)).toBe(validate);
  });

  it('keeps the foundation one-argument API as the default path', () => {
    expect(compileSchema(schemaPath)(validRequest)).toBe(true);
  });
});
