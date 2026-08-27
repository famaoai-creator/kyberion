import { compileSchema } from './ajv.js';
import { readJson } from './json.js';
import { getFoundationIo } from './io.js';
import type { ValidateFunction } from 'ajv';

export interface GovernedCatalogOptions<T> {
  id: string;
  path: string | (() => string);
  schema: string | ValidateFunction<T>;
  fallback?: T | (() => T);
  onFallback?: (error: unknown, fallback: T) => void;
}

export interface GovernedCatalog<T> {
  readonly id: string;
  path(): string;
  validate(value: unknown, sourcePath?: string): T;
  load(): T;
  reset(): void;
}

function cloneFallback<T>(fallback: T | (() => T)): T {
  const value = typeof fallback === 'function' ? (fallback as () => T)() : fallback;
  return value && typeof value === 'object' ? (structuredClone(value) as T) : value;
}

export function defineCatalog<T>(options: GovernedCatalogOptions<T>): GovernedCatalog<T> {
  let cached: T | undefined;
  let cachedPath: string | undefined;
  let cachedSignature: string | undefined;
  let validator: ValidateFunction<T> | undefined;

  const resolvePath = (): string =>
    typeof options.path === 'function' ? options.path() : options.path;

  const validate = (value: unknown, sourcePath: string): T => {
    validator ||=
      typeof options.schema === 'string' ? compileSchema<T>(options.schema) : options.schema;
    // `$schema` is governance metadata, not part of the runtime contract.
    // Keep it in the source artifact while excluding it from domain schemas
    // that use additionalProperties=false.
    const candidate =
      value && typeof value === 'object' && !Array.isArray(value) && '$schema' in value
        ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$schema'))
        : value;
    if (!validator(candidate)) {
      const errors = (validator.errors || [])
        .map((error) =>
          `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
        )
        .join('; ');
      throw new Error(`Invalid catalog ${options.id} at ${sourcePath}: ${errors}`);
    }
    return candidate as T;
  };

  return {
    id: options.id,
    path: resolvePath,
    validate(value: unknown, sourcePath = resolvePath()): T {
      return validate(value, sourcePath);
    },
    load(): T {
      const catalogPath = resolvePath();
      if (getFoundationIo().exists(catalogPath)) {
        const stat = getFoundationIo().stat(catalogPath);
        const signature = `${stat.mtimeMs}:${stat.size}`;
        if (cached !== undefined && cachedPath === catalogPath && cachedSignature === signature) {
          return cached;
        }
        cached = validate(readJson<unknown>(catalogPath), catalogPath);
        cachedPath = catalogPath;
        cachedSignature = signature;
        return cached;
      }
      if (options.fallback === undefined) {
        throw new Error(`Catalog ${options.id} is missing: ${catalogPath}`);
      }
      const fallback = cloneFallback(options.fallback);
      options.onFallback?.(new Error(`Catalog ${options.id} is missing: ${catalogPath}`), fallback);
      cached = fallback;
      cachedPath = catalogPath;
      cachedSignature = undefined;
      return cached;
    },
    reset(): void {
      cached = undefined;
      cachedPath = undefined;
      cachedSignature = undefined;
      validator = undefined;
    },
  };
}
