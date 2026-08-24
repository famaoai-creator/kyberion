import AjvModule, { type ValidateFunction } from 'ajv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './json.js';

type AjvLike = {
  addSchema(schema: object, id: string): void;
  compile<T>(schema: object): ValidateFunction<T>;
};
type AjvConstructor = new (options: Record<string, boolean>) => AjvLike;

const AjvConstructor =
  (AjvModule as unknown as { default?: AjvConstructor }).default ||
  (AjvModule as unknown as AjvConstructor);

export function createAjv(): AjvLike {
  return new AjvConstructor({ allErrors: true, strict: false, allowUnionTypes: true });
}

export function compileSchema<T = unknown>(schemaPath: string): ValidateFunction<T> {
  const validator = createAjv();
  const schema = readJson<Record<string, unknown>>(schemaPath);
  if (typeof schema.$id === 'string' && schema.$id) {
    validator.addSchema(schema, schema.$id);
  }
  validator.addSchema(schema, pathToFileURL(path.resolve(schemaPath)).href);
  return validator.compile<T>(schema);
}
