import { TransformerContract } from './types.js';

/**
 * Standard ADF Transformer v1.0
 * Unified normalization engine for Kyberion Actuators.
 */

export function getValueByPath(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  if (path === 'output') return obj; // Literal 'output' represents the whole source if it's a string
  
  // Basic support for $.path or path
  const normalizedPath = path.startsWith('$.') ? path.slice(2) : path;
  return normalizedPath.split('.').reduce((prev, curr) => prev && prev[curr], obj);
}

/**
 * Applies a transformation contract to raw source data.
 */
export function transform(source: any, contract: TransformerContract): any {
  const result: any = { ...(contract.defaults || {}) };

  if (contract.type === 'json_map') {
    for (const [targetKey, sourcePath] of Object.entries(contract.mapping)) {
      const val = getValueByPath(source, sourcePath);
      if (val !== undefined) {
        result[targetKey] = val;
      }
    }
  } else if (contract.type === 'regex_extract') {
    const textSource = typeof source === 'string' ? source : JSON.stringify(source);
    for (const [targetKey, pattern] of Object.entries(contract.mapping)) {
      const re = new RegExp(pattern);
      const match = textSource.match(re);
      if (match) {
        // Use group 1 if it exists, otherwise the whole match
        result[targetKey] = match[1] || match[0];
      }
    }
  }

  return result;
}
