import { isRecord } from './json-primitives';

export type ClientDeliverable = {
  artifactId: string;
  tenantSlug?: string;
  organizationId?: string;
  projectId?: string;
  missionId?: string;
  kind: string;
  storageClass: string;
  path?: string;
  externalRef?: string;
  previewText?: string;
  updatedAt: string;
  sizeBytes?: number;
  missing?: boolean;
  reviewVerdict?: string;
  reviewComment?: string;
};

export type DeliverablesResponse = {
  deliverables: ClientDeliverable[];
  accessRole: 'readonly' | 'localadmin';
};

type JsonRecord = Record<string, unknown>;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeOptionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return value === undefined ? undefined : typeof value === 'string' ? value : undefined;
}

function parseDeliverable(value: unknown): ClientDeliverable | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => DANGEROUS_KEYS.has(key)))
    return undefined;
  const required = ['artifactId', 'kind', 'storageClass', 'updatedAt'] as const;
  const strings = Object.fromEntries(
    required.map((key) => [
      key,
      typeof value[key] === 'string' && value[key].trim() ? value[key] : undefined,
    ])
  ) as Record<(typeof required)[number], string | undefined>;
  if (required.some((key) => !strings[key])) return undefined;
  const optionalKeys = [
    'tenantSlug',
    'organizationId',
    'projectId',
    'missionId',
    'path',
    'externalRef',
    'previewText',
    'reviewVerdict',
    'reviewComment',
  ] as const;
  const optionalStrings = Object.fromEntries(
    optionalKeys.map((key) => [key, safeOptionalString(value, key)])
  ) as Record<(typeof optionalKeys)[number], string | undefined>;
  if (optionalKeys.some((key) => value[key] !== undefined && optionalStrings[key] === undefined))
    return undefined;
  const sizeBytes = value.sizeBytes;
  if (
    sizeBytes !== undefined &&
    (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0)
  )
    return undefined;
  if (value.missing !== undefined && typeof value.missing !== 'boolean') return undefined;
  return {
    artifactId: strings.artifactId!,
    kind: strings.kind!,
    storageClass: strings.storageClass!,
    updatedAt: strings.updatedAt!,
    ...optionalStrings,
    ...(sizeBytes !== undefined ? { sizeBytes: sizeBytes as number } : {}),
    ...(value.missing !== undefined ? { missing: value.missing as boolean } : {}),
  };
}

export function parseDeliverablesResponse(value: unknown): DeliverablesResponse | undefined {
  if (!isRecord(value) || !Array.isArray(value.deliverables)) return undefined;
  const deliverables = value.deliverables.map(parseDeliverable);
  if (deliverables.some((entry) => !entry)) return undefined;
  const accessRole = value.accessRole;
  if (accessRole !== 'readonly' && accessRole !== 'localadmin') return undefined;
  return { deliverables: deliverables as ClientDeliverable[], accessRole };
}
