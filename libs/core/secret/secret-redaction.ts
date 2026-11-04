/**
 * Value-wise structural secret redaction for output exits (model answers,
 * stream chunks, transcripts) built on the active-secret registry.
 *
 * Walk values, never a stringified aggregate: once a value is
 * JSON-stringified a multi-line secret (PEM) appears as `\n`-escaped text
 * and a raw-value match misses it. Each string leaf is masked in place
 * (raw and JSON-escaped forms, see `redactSecretValuesInText`), object keys
 * included. The walk is depth- and size-bounded and cycle-safe; anything it
 * refuses to descend into is replaced with a marker (fail closed) rather
 * than returned unredacted.
 */

import { logger } from '../core.js';
import { redactSecretValuesInText, type SecretValueRedactionOptions } from './secret-guard.js';

export const REDACTION_DEPTH_LIMIT_MARKER = '[REDACTED_DEPTH_LIMIT]';
export const REDACTION_SIZE_LIMIT_MARKER = '[REDACTED_SIZE_LIMIT]';
export const REDACTION_CIRCULAR_MARKER = '[CIRCULAR]';

export const DEFAULT_REDACTION_MAX_DEPTH = 16;
export const DEFAULT_REDACTION_MAX_NODES = 20_000;

export interface DeepSecretRedactionOptions extends SecretValueRedactionOptions {
  /** Containers nested deeper than this are replaced by a marker. */
  readonly maxDepth?: number;
  /** Total visited nodes before the rest is replaced by a marker. */
  readonly maxNodes?: number;
}

/**
 * Returns a redacted copy of `value`. Strings, arrays, plain objects, Maps,
 * Sets and Errors are walked; numbers/booleans/bigints/null/undefined,
 * Dates and binary views pass through unchanged. Other class instances are
 * copied as plain objects of their own enumerable properties.
 */
export function redactSecretsDeep<T>(value: T, options: DeepSecretRedactionOptions = {}): T {
  const maxDepth = options.maxDepth ?? DEFAULT_REDACTION_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_REDACTION_MAX_NODES;
  const textOptions: SecretValueRedactionOptions = {
    ...(options.extraSecrets ? { extraSecrets: options.extraSecrets } : {}),
    ...(options.replacement !== undefined ? { replacement: options.replacement } : {}),
    ...(options.minLength !== undefined ? { minLength: options.minLength } : {}),
  };
  const ancestors = new WeakSet<object>();
  let visited = 0;
  const text = (input: string): string => redactSecretValuesInText(input, textOptions);

  const walk = (node: unknown, depth: number): unknown => {
    visited += 1;
    if (visited > maxNodes) return REDACTION_SIZE_LIMIT_MARKER;
    if (typeof node === 'string') return text(node);
    if (node === null || typeof node !== 'object') return node;
    if (node instanceof Date || ArrayBuffer.isView(node) || node instanceof ArrayBuffer) {
      return node;
    }
    if (ancestors.has(node)) return REDACTION_CIRCULAR_MARKER;
    if (depth >= maxDepth) return REDACTION_DEPTH_LIMIT_MARKER;
    ancestors.add(node);
    try {
      if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
      if (node instanceof Map) {
        const out = new Map<unknown, unknown>();
        for (const [key, entry] of node) out.set(walk(key, depth + 1), walk(entry, depth + 1));
        return out;
      }
      if (node instanceof Set) {
        const out = new Set<unknown>();
        for (const entry of node) out.add(walk(entry, depth + 1));
        return out;
      }
      if (node instanceof Error) {
        const out = new Error(text(node.message));
        out.name = node.name;
        out.stack = node.stack === undefined ? undefined : text(node.stack);
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node)) {
        out[text(key)] = walk(entry, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(node);
    }
  };

  const out = walk(value, 0) as T;
  if (visited > maxNodes) {
    logger.warn(
      `[secret-redaction] node cap reached — ${visited - maxNodes} value(s) replaced by ${REDACTION_SIZE_LIMIT_MARKER} | next: raise maxNodes for this exit or shrink the payload | evidence: maxNodes=${maxNodes}`
    );
  }
  return out;
}
