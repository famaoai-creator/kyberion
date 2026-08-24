import AjvModule, { type ValidateFunction } from 'ajv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './json.js';

type AjvLike = {
  addSchema(schema: object, id: string): void;
  getSchema<T = unknown>(id: string): ValidateFunction<T> | undefined;
  compile<T>(schema: object): ValidateFunction<T>;
};
type AjvConstructor = new (options: Record<string, boolean>) => AjvLike;

const AjvConstructor =
  (AjvModule as unknown as { default?: AjvConstructor }).default ||
  (AjvModule as unknown as AjvConstructor);

export function createAjv(): AjvLike {
  return new AjvConstructor({ allErrors: true, strict: false, allowUnionTypes: true });
}

function collectExternalRefs(value: unknown, refs: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectExternalRefs(item, refs);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === '$ref' && typeof nested === 'string' && nested && !nested.startsWith('#')) {
      refs.add(nested);
      continue;
    }
    collectExternalRefs(nested, refs);
  }
}

function registerSchema(validator: AjvLike, schemaPath: string, visited: Set<string>): void {
  const normalized = path.resolve(schemaPath);
  if (visited.has(normalized)) return;
  visited.add(normalized);

  const schema = readJson<Record<string, unknown>>(normalized);
  const refs = new Set<string>();
  collectExternalRefs(schema, refs);
  for (const ref of refs) {
    if (/^[a-z]+:/i.test(ref)) continue;
    registerSchema(validator, path.resolve(path.dirname(normalized), ref), visited);
  }

  const schemaIds = new Set<string>([pathToFileURL(normalized).href]);
  if (typeof schema.$id === 'string' && schema.$id) schemaIds.add(schema.$id);
  for (const schemaId of schemaIds) {
    if (!validator.getSchema(schemaId)) validator.addSchema(schema, schemaId);
  }
}

export function compileSchema<T = unknown>(schemaPath: string): ValidateFunction<T> {
  const validator = createAjv();
  const normalized = path.resolve(schemaPath);
  const schemaId = pathToFileURL(normalized).href;
  registerSchema(validator, normalized, new Set<string>());
  return validator.getSchema(schemaId) as ValidateFunction<T>;
}
