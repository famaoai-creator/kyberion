import { z } from 'zod';

/**
 * Compact JSON-shape hint for prompt-only structured ops (CLI backends without
 * native `--json-schema`). Shared by cursor-cli and opencode-cli backends.
 */
function zodDefOf(schema: z.ZodTypeAny): { type?: string; [key: string]: unknown } {
  const withInternals = schema as unknown as {
    _zod?: { def?: { type?: string; [key: string]: unknown } };
  };
  return withInternals._zod?.def ?? {};
}

function zodShape(schema: z.ZodTypeAny): string {
  const def = zodDefOf(schema);
  if (def.type === 'optional' || def.type === 'default' || def.type === 'prefault') {
    const inner = def.innerType as z.ZodTypeAny | undefined;
    const rendered = inner ? zodShape(inner) : 'value';
    return def.type === 'optional' ? `${rendered} (optional)` : rendered;
  }
  if (def.type === 'array') {
    const element = def.element as z.ZodTypeAny | undefined;
    return `array of ${element ? zodShape(element) : 'value'}`;
  }
  if (def.type === 'object') {
    const shape = def.shape as Record<string, z.ZodTypeAny> | undefined;
    const entries = Object.entries(shape ?? {}).map(([key, value]) => `${key}: ${zodShape(value)}`);
    return `{ ${entries.join(', ')} }`;
  }
  if (def.type === 'enum') {
    const values = def.values as unknown;
    return Array.isArray(values) ? `one of ${values.join('/')}` : 'string';
  }
  if (def.type === 'string') return 'string';
  if (def.type === 'number') return 'number';
  if (def.type === 'boolean') return 'boolean';
  const inner = def.innerType as z.ZodTypeAny | undefined;
  if (inner) return zodShape(inner);
  return 'value';
}

export function schemaHint(schema: z.ZodTypeAny): string {
  try {
    return zodShape(schema);
  } catch {
    return 'a JSON object';
  }
}
