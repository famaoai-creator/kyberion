import { logger } from '../logger.js';

/**
 * Logic Utilities for ADF and Pipeline Processing.
 */

/**
 * Resolves variables in a string or object using the provided context.
 * Supports {{variable.path}} syntax.
 */
export function resolveVars(val: any, ctx: any): any {
  if (typeof val !== 'string') return val;
  
  // Single variable match: "{{var}}" returns the raw data (maintains type)
  const singleVarMatch = val.match(/^{{(.*?)}}$/);
  if (singleVarMatch) {
    const parts = singleVarMatch[1].trim().split('.');
    let current = ctx;
    for (const part of parts) { 
      current = current?.[part]; 
    }
    return current !== undefined ? current : '';
  }

  // Multi-variable match or string mix: returns interpolated string
  return val.replace(/{{(.*?)}}/g, (_, p) => {
    const parts = p.trim().split('.');
    let current = ctx;
    for (const part of parts) { 
      current = current?.[part]; 
    }
    return current !== undefined ? (typeof current === 'object' ? JSON.stringify(current) : String(current)) : '';
  });
}

/**
 * Evaluates a condition against the provided context.
 */
export function evaluateCondition(cond: any, ctx: any): boolean {
  if (!cond) return true;
  const parts = cond.from.split('.');
  let val = ctx;
  for (const part of parts) { 
    val = val?.[part]; 
  }
  
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
