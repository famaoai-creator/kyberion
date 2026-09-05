const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PREVIEW_KINDS = new Set(['markdown', 'text', 'image', 'other']);

export type ConciergeArtifactPreview = {
  name: string;
  kind: 'markdown' | 'text' | 'image' | 'other';
  content?: string;
  truncated?: boolean;
  data_uri?: string;
  missing?: boolean;
  too_large?: boolean;
};

export type ConciergeOutcomePreview = {
  entry_id: string;
  total: number;
  shown: number;
  files: ConciergeArtifactPreview[];
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function optionalBoolean(record: JsonRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'boolean';
}

function optionalString(record: JsonRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

function parseArtifact(value: unknown): ConciergeArtifactPreview | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.kind !== 'string' ||
    !PREVIEW_KINDS.has(value.kind) ||
    !optionalString(value, 'content') ||
    !optionalBoolean(value, 'truncated') ||
    !optionalString(value, 'data_uri') ||
    !optionalBoolean(value, 'missing') ||
    !optionalBoolean(value, 'too_large')
  ) {
    return undefined;
  }
  return {
    name: value.name,
    kind: value.kind as ConciergeArtifactPreview['kind'],
    ...(value.content === undefined ? {} : { content: value.content as string }),
    ...(value.truncated === undefined ? {} : { truncated: value.truncated as boolean }),
    ...(value.data_uri === undefined ? {} : { data_uri: value.data_uri as string }),
    ...(value.missing === undefined ? {} : { missing: value.missing as boolean }),
    ...(value.too_large === undefined ? {} : { too_large: value.too_large as boolean }),
  };
}

export function parseConciergeOutcomePreviewResponse(
  value: unknown
): ConciergeOutcomePreview | undefined {
  if (!isRecord(value) || value.ok !== true || !hasSafeTree(value) || !isRecord(value.preview)) {
    return undefined;
  }
  const preview = value.preview;
  if (
    typeof preview.entry_id !== 'string' ||
    !nonNegativeInteger(preview.total) ||
    !nonNegativeInteger(preview.shown) ||
    preview.shown > preview.total ||
    !Array.isArray(preview.files)
  ) {
    return undefined;
  }
  const files = preview.files.map(parseArtifact);
  if (files.some((file) => !file)) return undefined;
  return {
    entry_id: preview.entry_id,
    total: preview.total,
    shown: preview.shown,
    files: files as ConciergeArtifactPreview[],
  };
}
