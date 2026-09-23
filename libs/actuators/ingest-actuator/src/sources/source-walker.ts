/**
 * source-walker.ts
 * Common types and utilities for ingest source walkers.
 */

export interface SyncSourceItem {
  source_id: string;
  source_version?: string;
  content_ref: string;
  modified_at?: string;
}

export interface PageWalkResult {
  items: SyncSourceItem[];
  highWater: string;
  truncated: boolean;
  pages: number;
}

export type SyncSourceTransport = (
  serviceId: string,
  action: string,
  params: Record<string, unknown>,
  auth: 'none' | 'secret-guard'
) => Promise<unknown>;

export interface SourceWalkerInput {
  tenant_slug: string;
  source_params: Record<string, unknown>;
  transport: SyncSourceTransport;
  auth: 'none' | 'secret-guard';
  watermark: string;
  maxItems: number;
  pageLimit: number;
}

export interface SourceWalker {
  readonly systemId: string;
  walk(input: SourceWalkerInput): Promise<PageWalkResult>;
}

export const MAX_PAGES = 1000;

export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`ingest:sync_source — ${what} is not an object (fail-closed)`);
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`ingest:sync_source — ${what} is not an array (fail-closed)`);
  }
  return value;
}

export function requireStringParam(
  params: Record<string, unknown>,
  key: string,
  source: string
): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ingest:sync_source — source_params.${key} is required for ${source}`);
  }
  return value;
}

export function isNewerIso(candidate: string, watermark: string): boolean {
  if (!watermark) return true;
  const candidateMs = Date.parse(candidate);
  const watermarkMs = Date.parse(watermark);
  if (Number.isNaN(candidateMs) || Number.isNaN(watermarkMs)) return true;
  return candidateMs > watermarkMs;
}

export function maxIso(current: string, candidate: string | undefined): string {
  if (!candidate) return current;
  if (!current) return candidate;
  return isNewerIso(candidate, current) ? candidate : current;
}
