import type { Ajv, ValidateFunction } from 'ajv';
import path from 'node:path';
import { safeReadFile } from './secure-io.js';

function collectExternalRefs(value: unknown, refs: Set<string>) {
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

function registerSchema(ajv: Ajv, schemaPath: string, visited: Set<string>): any {
  const normalized = path.resolve(schemaPath);
  if (visited.has(normalized)) {
    const raw = safeReadFile(normalized, { encoding: 'utf8' }) as string;
    return JSON.parse(raw);
  }
  visited.add(normalized);
  const raw = safeReadFile(normalized, { encoding: 'utf8' }) as string;
  const schema = JSON.parse(raw);
  const refs = new Set<string>();
  collectExternalRefs(schema, refs);
  for (const ref of refs) {
    if (/^[a-z]+:/i.test(ref)) continue;
    registerSchema(ajv, path.resolve(path.dirname(normalized), ref), visited);
  }
  const schemaId = typeof schema.$id === 'string' ? schema.$id : normalized;
  if (!ajv.getSchema(schemaId)) {
    ajv.addSchema(schema, schemaId);
  }
  return schema;
}

export function compileSchemaFromPath(ajv: Ajv, schemaPath: string): ValidateFunction {
  const schema = registerSchema(ajv, schemaPath, new Set<string>());
  if (typeof schema?.$id === 'string') {
    const existing = ajv.getSchema(schema.$id);
    if (existing) return existing;
  }
  return ajv.compile(schema);
}
