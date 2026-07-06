import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';

/**
 * Logic Utilities for ADF and Pipeline Processing.
 */

/**
 * Resolve an inline path token `@domain[:subPath]` to a machine-local absolute path via
 * {@link pathResolver}, so pipelines/ADF can reference repo locations portably
 * (`{{@shared:tmp/run.json}}`, `{{@knowledge:product/x.md}}`, `{{@root}}`). Returns `undefined`
 * for an unknown domain so the caller keeps the literal token. The result is absolute and
 * machine-local — fine for runtime use, but do not persist it (use `system:resolve_path`'s
 * `to_relative`/`normalize` before storing).
 */
function resolvePathToken(token: string): string | undefined {
  const trimmed = token.slice(1).trim(); // drop leading '@'
  const sepIdx = trimmed.indexOf(':');
  const domain = (sepIdx >= 0 ? trimmed.slice(0, sepIdx) : trimmed).trim();
  const subPath = sepIdx >= 0 ? trimmed.slice(sepIdx + 1).trim() : '';
  switch (domain) {
    case 'root':
      return subPath ? pathResolver.rootResolve(subPath) : pathResolver.rootDir();
    case 'knowledge':
      return pathResolver.knowledge(subPath);
    case 'active':
      return pathResolver.active(subPath);
    case 'shared':
      return pathResolver.shared(subPath);
    case 'tmp':
      return pathResolver.shared(subPath ? `tmp/${subPath}` : 'tmp');
    case 'vault':
      return pathResolver.vault(subPath);
    default:
      return undefined;
  }
}

/**
 * Resolves variables in a string or object using the provided context.
 * Supports {{variable.path}} syntax.
 */
export function tokenizePath(input: string): string[] {
  return String(input || '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function getPathValue(ctx: any, pathLike?: string): any {
  if (!pathLike) return undefined;
  if (String(pathLike).startsWith('env.')) {
    return process.env[String(pathLike).slice(4)];
  }
  const parts = tokenizePath(pathLike);
  let current = ctx;
  for (const part of parts) {
    current = current?.[part];
  }
  return current;
}

export function resolveVars(val: any, ctx: any): any {
  if (typeof val !== 'string') return val;

  // Single variable match: "{{var}}" or "{{var|default}}" — returns raw value (preserves type)
  // Uses [^{}]+ to avoid false matches on strings like "{{a}} / {{b}}" which start AND end with {{ }}
  const singleVarMatch = val.match(/^\{\{([^{}]+)\}\}$/);
  if (singleVarMatch) {
    const token = singleVarMatch[1].trim();
    if (token.startsWith('@')) {
      const resolved = resolvePathToken(token);
      return resolved !== undefined ? resolved : val; // unknown domain → keep literal
    }
    const [varName, defaultValue] = token.split('|').map((s) => s.trim());
    const current = getPathValue(ctx, varName);
    if (current !== undefined) return current;
    return defaultValue !== undefined ? defaultValue : '';
  }

  // Multi-variable or mixed string: "Hello {{name|World}}" → interpolated string
  return val.replace(/{{(.*?)}}/g, (match, p) => {
    const token = String(p).trim();
    if (token.startsWith('@')) {
      const resolved = resolvePathToken(token);
      return resolved !== undefined ? resolved : match; // unknown domain → keep literal
    }
    const [varName, defaultValue] = token.split('|').map((s: string) => s.trim());
    const current = getPathValue(ctx, varName);
    if (current !== undefined) {
      return typeof current === 'object' ? JSON.stringify(current) : String(current);
    }
    return defaultValue !== undefined ? defaultValue : '';
  });
}

export function resolveRequiredStringParam(
  params: Record<string, any> | undefined,
  keys: string[],
  resolveFn: (value: any) => any = (value) => value,
  label = 'operation'
): string {
  const normalizedKeys = [...new Set(keys.map((key) => String(key).trim()).filter(Boolean))];
  for (const key of normalizedKeys) {
    const resolved = resolveFn(params?.[key]);
    if (typeof resolved === 'string' && resolved.trim()) {
      return resolved.trim();
    }
  }

  if (normalizedKeys.length === 1) {
    throw new Error(`${label} requires params.${normalizedKeys[0]}`);
  }
  throw new Error(
    `${label} requires one of ${normalizedKeys.map((key) => `params.${key}`).join(' or ')}`
  );
}

/**
 * Evaluates a condition against the provided context.
 */
export function evaluateCondition(cond: any, ctx: any): boolean {
  if (!cond) return true;

  if (typeof cond === 'string') {
    return !!getPathValue(ctx, cond);
  }

  const val = getPathValue(ctx, cond.from);

  switch (cond.operator) {
    case 'exists':
      return val !== undefined && val !== null;
    case 'not_exists':
      return val === undefined || val === null;
    case 'empty':
      return Array.isArray(val) ? val.length === 0 : !val;
    case 'not_empty':
      return Array.isArray(val) ? val.length > 0 : !!val;
    case 'eq':
      return val === cond.value;
    case 'ne':
      return val !== cond.value;
    case 'gt':
      return Number(val) > cond.value;
    case 'lt':
      return Number(val) < cond.value;
    case 'and':
      return (
        Array.isArray(cond.conditions) &&
        cond.conditions.every((c: any) => evaluateCondition(c, ctx))
      );
    case 'or':
      return (
        Array.isArray(cond.conditions) &&
        cond.conditions.some((c: any) => evaluateCondition(c, ctx))
      );
    default:
      return !!val;
  }
}

export function resolveWriteArtifactSpec(
  params: any,
  ctx: any,
  resolveFn: (value: any) => any = (value) => value
): { path: string; content: any } {
  const pathValue = resolveRequiredStringParam(
    params,
    ['path', 'output_path'],
    resolveFn,
    'write_artifact'
  );

  if (params?.content !== undefined) {
    return {
      path: pathValue,
      content: resolveFn(params.content),
    };
  }

  if (params?.data !== undefined) {
    return {
      path: pathValue,
      content: resolveFn(params.data),
    };
  }

  if (params?.from) {
    return {
      path: pathValue,
      content: getPathValue(ctx, params.from),
    };
  }

  return {
    path: pathValue,
    content: ctx?.last_transform ?? ctx?.last_capture,
  };
}
