export function withoutSchemaMetadata<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const { $schema: _schema, ...contract } = payload as Record<string, unknown>;
  return contract as T;
}
