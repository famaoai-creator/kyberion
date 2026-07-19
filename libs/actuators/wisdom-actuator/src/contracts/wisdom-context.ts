export type WisdomContextValue = unknown;

export interface WisdomContext {
  [key: string]: WisdomContextValue;
}

export const WISDOM_RESERVED_CONTEXT_KEYS = new Set(['__wisdom_receipts', '__wisdom_runtime']);

export interface ContextAssignmentOptions {
  compatibilityMode?: boolean;
}

export function assignWisdomContextValue<T extends WisdomContext>(
  context: T,
  key: string,
  value: WisdomContextValue,
  options: ContextAssignmentOptions = {}
): T {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    throw new Error('[INVALID_CONTEXT_KEY] export_as must be a non-empty string');
  }
  if (WISDOM_RESERVED_CONTEXT_KEYS.has(normalizedKey)) {
    throw new Error(`[RESERVED_CONTEXT_KEY] Cannot write reserved context key: ${normalizedKey}`);
  }
  if (!options.compatibilityMode && Object.prototype.hasOwnProperty.call(context, normalizedKey)) {
    throw new Error(`[CONTEXT_KEY_COLLISION] Context key already exists: ${normalizedKey}`);
  }
  return { ...context, [normalizedKey]: value } as T;
}

export function mergeWisdomContext<T extends WisdomContext>(
  context: T,
  values: Record<string, WisdomContextValue>,
  options: ContextAssignmentOptions = {}
): T {
  let next = context;
  for (const [key, value] of Object.entries(values)) {
    next = assignWisdomContextValue(next, key, value, options);
  }
  return next;
}
