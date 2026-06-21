import { describe, expect, it } from 'vitest';
import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from '../schema-loader.js';
import { safeReadFile } from '../secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('pptx theme pack schema', () => {
  it('accepts the bundled example contract', () => {
    const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'knowledge/product/schemas/pptx-theme-pack.schema.json'));
    const example = JSON.parse(safeReadFile(path.resolve(process.cwd(), 'knowledge/product/schemas/pptx-theme-pack.example.json'), { encoding: 'utf8' }) as string);
    expect(validate(example)).toBe(true);
  });
});
