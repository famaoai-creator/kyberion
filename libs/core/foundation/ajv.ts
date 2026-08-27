import AjvModule, { type ValidateFunction } from 'ajv';
import Ajv2020Module from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './json.js';

function readSchema<T>(schemaPath: string): T {
  return readJson<T>(schemaPath);
}

type AjvLike = {
  addSchema(schema: object, id: string): void;
  getSchema<T = unknown>(id: string): ValidateFunction<T> | undefined;
  compile<T>(schema: object): ValidateFunction<T>;
};
type AjvInstance = import('ajv').default;
type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

type AddFormats = (validator: AjvInstance, options?: { keywords?: boolean }) => AjvInstance;

function resolveConstructor(moduleValue: unknown): AjvConstructor {
  return (moduleValue as { default?: AjvConstructor }).default || (moduleValue as AjvConstructor);
}

function resolveAddFormats(moduleValue: unknown): AddFormats {
  return (moduleValue as { default?: AddFormats }).default || (moduleValue as AddFormats);
}

// Governance schemas use the standard `format` vocabulary (`date-time`, `date`,
// `uri`, `uri-reference`, `uuid`). Without ajv-formats those keywords are
// unknown, and `strict: true` rejects the schema at compile time. Registering
// the format vocabulary on every shared instance keeps the strict mode while
// letting format-bearing contracts compile and actually validate.
//
// `keywords: false` skips the `formatMaximum`/`formatMinimum` comparison
// keywords (unused in this repo). Those are the only part of ajv-formats that
// throws on a second registration, so leaving them out keeps the many existing
// call sites that still run `addFormats(createAjv())` themselves working:
// re-registering a format is an idempotent assignment, re-adding a keyword is
// not.
function withFormats(validator: AjvInstance): AjvInstance {
  return resolveAddFormats(addFormatsModule)(validator, { keywords: false });
}

export function createAjv(options: Record<string, unknown> = {}): AjvInstance {
  const AjvConstructor = resolveConstructor(AjvModule);
  return withFormats(
    new AjvConstructor({
      allErrors: true,
      strict: true,
      strictRequired: false,
      allowUnionTypes: true,
      ...options,
    })
  );
}

export function createAjv2020(options: Record<string, unknown> = {}): AjvInstance {
  const Ajv2020Constructor = resolveConstructor(Ajv2020Module);
  return withFormats(
    new Ajv2020Constructor({
      allErrors: true,
      strict: true,
      strictRequired: false,
      ...options,
    })
  );
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

function registerSchema(
  validator: AjvLike,
  schemaPath: string,
  visited: Set<string>
): Record<string, unknown> {
  const normalized = path.resolve(schemaPath);
  if (visited.has(normalized)) {
    return readSchema<Record<string, unknown>>(normalized);
  }
  visited.add(normalized);

  const schema = readSchema<Record<string, unknown>>(normalized);
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
  return schema;
}

export function compileSchema<T = unknown>(
  schemaPath: string,
  validator: AjvLike = createAjv()
): ValidateFunction<T> {
  const normalized = path.resolve(schemaPath);
  const schemaId = pathToFileURL(normalized).href;
  const schema = registerSchema(validator, normalized, new Set<string>());
  const byPath = validator.getSchema<T>(schemaId);
  if (byPath) return byPath;
  if (typeof schema.$id === 'string' && schema.$id) {
    const bySchemaId = validator.getSchema<T>(schema.$id);
    if (bySchemaId) return bySchemaId;
  }
  return validator.compile<T>(schema);
}
