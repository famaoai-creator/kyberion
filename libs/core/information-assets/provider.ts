import { createHash } from 'node:crypto';
import type { InformationAssetLocation, InformationObject } from './types.js';
export interface CollectorCursor {
  checkpoint?: string;
  page_token?: string;
  phase?: string;
}
export interface CollectorSubject {
  subject_id: string;
  change_id: string;
  event_type: string;
  source_url?: string;
  occurred_at?: string;
  data: InformationObject;
}
export interface CollectorPage {
  subjects: CollectorSubject[];
  next: CollectorCursor;
  complete: boolean;
}
export interface CollectorTransport {
  (action: string, params: Record<string, unknown>): Promise<unknown>;
}
export interface InformationAssetCollector {
  id: string;
  service_id: string;
  asset_types: readonly string[];
  actions: readonly string[];
  collect(
    location: InformationAssetLocation,
    cursor: CollectorCursor,
    call: CollectorTransport,
    now?: Date
  ): Promise<CollectorPage>;
}
export class CollectorFullSyncRequired extends Error {}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('collector_response_object_required');
  return value as Record<string, unknown>;
}
export function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('collector_response_array_required');
  return value.map(object);
}
export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('collector_missing_' + name);
  return value;
}
export function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('collector_optional_text_invalid');
  return value;
}
export function jsonObject(value: Record<string, unknown>): InformationObject {
  const encoded = JSON.stringify(value);
  if (encoded.length > 262144) throw new Error('collector_subject_too_large');
  return JSON.parse(encoded) as InformationObject;
}

export function providerRevision(value: unknown): string {
  const stable = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(stable)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, stable(v)])
          )
        : input;
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
