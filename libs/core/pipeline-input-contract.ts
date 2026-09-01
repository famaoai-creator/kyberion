export type PipelineInputSchema = Record<string, unknown>;

function schemaPlaceholder(schema: PipelineInputSchema | undefined): unknown {
  if (!schema) return '';
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schemaPlaceholder(schema.anyOf[0] as PipelineInputSchema);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ('const' in schema) return schema.const;
  if (schema.format === 'uri' || schema.format === 'uri-reference' || schema.format === 'url') {
    return 'https://example.invalid';
  }
  if (schema.format === 'email') return 'operator@example.invalid';
  if (schema.format === 'date-time') return '2026-01-01T00:00:00.000Z';
  if (schema.format === 'date') return '2026-01-01';
  if (typeof schema.pattern === 'string') {
    if (/\\d\{4\}-W\\d\{2\}/u.test(schema.pattern)) return '2026-W01';
    if (/\\d\{4\}-\\d\{2\}-\\d\{2\}/u.test(schema.pattern)) return '2026-01-01';
  }
  switch (schema.type) {
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return 0;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return typeof schema.minLength === 'number'
        ? 'p'.repeat(
            Math.max(1, Math.min(schema.minLength, Number(schema.maxLength) || schema.minLength))
          )
        : 'pipeline-placeholder';
  }
}

/** Resolve whole-value pipeline templates into values compatible with a schema. */
export function resolvePipelineInputPlaceholders(
  value: unknown,
  schema?: PipelineInputSchema
): unknown {
  if (typeof value === 'string' && /^\{\{[^{}]+\}\}$/.test(value)) {
    return schemaPlaceholder(schema);
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      resolvePipelineInputPlaceholders(entry, schema?.items as PipelineInputSchema | undefined)
    );
  }
  if (!value || typeof value !== 'object') return value;
  const properties =
    schema?.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, PipelineInputSchema>)
      : {};
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      resolvePipelineInputPlaceholders(entry, properties[key]),
    ])
  );
}
