import { logger } from '../core.js';

/**
 * Logic Utilities for ADF and Pipeline Processing.
 */

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
  
  // Single variable match: "{{var}}" returns the raw data (maintains type)
  const singleVarMatch = val.match(/^{{(.*?)}}$/);
  if (singleVarMatch) {
    const current = getPathValue(ctx, singleVarMatch[1].trim());
    return current !== undefined ? current : '';
  }

  // Multi-variable match or string mix: returns interpolated string
  return val.replace(/{{(.*?)}}/g, (_, p) => {
    const current = getPathValue(ctx, p.trim());
    return current !== undefined ? (typeof current === 'object' ? JSON.stringify(current) : String(current)) : '';
  });
}

/**
 * Evaluates a condition against the provided context.
 */
export function evaluateCondition(cond: any, ctx: any): boolean {
  if (!cond) return true;
  const val = getPathValue(ctx, cond.from);
  
  switch (cond.operator) {
    case 'exists': return val !== undefined && val !== null;
    case 'not_exists': return val === undefined || val === null;
    case 'empty': return Array.isArray(val) ? val.length === 0 : !val;
    case 'not_empty': return Array.isArray(val) ? val.length > 0 : !!val;
    case 'eq': return val === cond.value;
    case 'ne': return val !== cond.value;
    case 'gt': return Number(val) > cond.value;
    case 'lt': return Number(val) < cond.value;
    default: return !!val;
  }
}

export function resolveWriteArtifactSpec(
  params: any,
  ctx: any,
  resolveFn: (value: any) => any = (value) => value,
): { path: string; content: any } {
  const pathValue = resolveFn(params?.path || params?.output_path);
  if (!pathValue || typeof pathValue !== 'string') {
    throw new Error('write_artifact requires params.path or params.output_path');
  }

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
