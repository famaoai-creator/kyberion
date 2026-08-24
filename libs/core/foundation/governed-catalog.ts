import { compileSchema } from './ajv.js';
import { readJson } from './json.js';
import { safeExistsSync } from '../secure-io.js';
import type { ValidateFunction } from 'ajv';

export interface GovernedCatalogOptions<T> {
  id: string;
  path: string | (() => string);
  schema?: string | ValidateFunction<T>;
  fallback?: T | (() => T);
  onFallback?: (error: unknown, fallback: T) => void;
}

export interface GovernedCatalog<T> {
  readonly id: string;
  path(): string;
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
  let cachedRaw: string | undefined;
  let validator: ValidateFunction<T> | undefined;

  const resolvePath = (): string =>
    typeof options.path === 'function' ? options.path() : options.path;

  const validate = (value: unknown, sourcePath: string): T => {
    if (!options.schema) return value as T;
    validator ||=
      typeof options.schema === 'string' ? compileSchema<T>(options.schema) : options.schema;
    if (!validator(value)) {
      const errors = (validator.errors || [])
        .map((error) =>
          `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
        )
        .join('; ');
      throw new Error(`Invalid catalog ${options.id} at ${sourcePath}: ${errors}`);
    }
    return value as T;
  };

  return {
    id: options.id,
    path: resolvePath,
    load(): T {
      const catalogPath = resolvePath();
      if (safeExistsSync(catalogPath)) {
        const raw = JSON.stringify(readJson<unknown>(catalogPath));
        if (cached !== undefined && cachedPath === catalogPath && cachedRaw === raw) return cached;
        cached = validate(JSON.parse(raw), catalogPath);
        cachedPath = catalogPath;
        cachedRaw = raw;
        return cached;
      }
      if (options.fallback === undefined) {
        throw new Error(`Catalog ${options.id} is missing: ${catalogPath}`);
      }
      const fallback = cloneFallback(options.fallback);
      options.onFallback?.(new Error(`Catalog ${options.id} is missing: ${catalogPath}`), fallback);
      cached = fallback;
      cachedPath = catalogPath;
      cachedRaw = undefined;
      return cached;
    },
    reset(): void {
      cached = undefined;
      cachedPath = undefined;
      cachedRaw = undefined;
      validator = undefined;
    },
  };
}
