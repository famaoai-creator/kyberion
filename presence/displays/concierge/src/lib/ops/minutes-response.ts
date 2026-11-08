import { isRecord } from '@agent/core/foundation/primitives';

/**
 * Client-side mirrors of the /api/ops/minutes payloads
 * (`lib/ops/meeting-minutes.ts` `MinutesItem` / `MinutesContent`), with the
 * same strict shape checks as the other ops response parsers.
 */

export type ClientMinutesSource = 'mission' | 'pad' | 'notepad';

export interface ClientMinutesItem {
  /** `${source}:${key}` — the address passed back to /api/ops/minutes/content. */
  id: string;
  source: ClientMinutesSource;
  key: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  tier?: string;
  tenantSlug?: string;
  missionId?: string;
  path?: string;
  summary?: string;
}

export interface ClientMinutesAttachment {
  label: string;
  content: string;
}

export interface ClientMinutesContent {
  id: string;
  source: ClientMinutesSource;
  title: string;
  createdAt?: string;
  missionId?: string;
  tenantSlug?: string;
  tier?: string;
  /** The minutes document (markdown when available). */
  content: string;
  attachments?: ClientMinutesAttachment[];
  path?: string;
}

export interface MinutesResponse {
  minutes: ClientMinutesItem[];
}

type JsonRecord = Record<string, unknown>;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SOURCES = new Set<ClientMinutesSource>(['mission', 'pad', 'notepad']);

function clean(value: unknown): value is JsonRecord {
  return isRecord(value) && !Object.keys(value).some((key) => DANGEROUS_KEYS.has(key));
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : typeof value === 'string' ? value : undefined;
}

function parseSource(value: unknown): ClientMinutesSource | undefined {
  return typeof value === 'string' && SOURCES.has(value as ClientMinutesSource)
    ? (value as ClientMinutesSource)
    : undefined;
}

const OPTIONAL_ITEM_KEYS = [
  'updatedAt',
  'tier',
  'tenantSlug',
  'missionId',
  'path',
  'summary',
] as const;

function parseItem(value: unknown): ClientMinutesItem | undefined {
  if (!clean(value)) return undefined;
  const required = ['id', 'key', 'title', 'createdAt'] as const;
  const strings = Object.fromEntries(
    required.map((key) => [
      key,
      typeof value[key] === 'string' && value[key].trim() ? value[key] : undefined,
    ])
  ) as Record<(typeof required)[number], string | undefined>;
  if (required.some((key) => !strings[key])) return undefined;
  const source = parseSource(value.source);
  if (!source) return undefined;
  const optionalStrings = Object.fromEntries(
    OPTIONAL_ITEM_KEYS.map((key) => [key, optionalString(value[key])])
  ) as Record<(typeof OPTIONAL_ITEM_KEYS)[number], string | undefined>;
  if (
    OPTIONAL_ITEM_KEYS.some((key) => value[key] !== undefined && optionalStrings[key] === undefined)
  )
    return undefined;
  return {
    id: strings.id!,
    source,
    key: strings.key!,
    title: strings.title!,
    createdAt: strings.createdAt!,
    ...optionalStrings,
  };
}

const OPTIONAL_CONTENT_KEYS = ['createdAt', 'missionId', 'tenantSlug', 'tier', 'path'] as const;

function parseAttachment(value: unknown): ClientMinutesAttachment | undefined {
  if (!clean(value)) return undefined;
  if (typeof value.label !== 'string' || !value.label.trim()) return undefined;
  if (typeof value.content !== 'string') return undefined;
  return { label: value.label, content: value.content };
}

function parseContent(value: unknown): ClientMinutesContent | undefined {
  if (!clean(value)) return undefined;
  if (typeof value.id !== 'string' || !value.id.trim()) return undefined;
  const source = parseSource(value.source);
  if (!source) return undefined;
  if (typeof value.title !== 'string') return undefined;
  if (typeof value.content !== 'string') return undefined;
  const optionalStrings = Object.fromEntries(
    OPTIONAL_CONTENT_KEYS.map((key) => [key, optionalString(value[key])])
  ) as Record<(typeof OPTIONAL_CONTENT_KEYS)[number], string | undefined>;
  if (
    OPTIONAL_CONTENT_KEYS.some(
      (key) => value[key] !== undefined && optionalStrings[key] === undefined
    )
  )
    return undefined;
  let attachments: ClientMinutesAttachment[] | undefined;
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) return undefined;
    const parsed = value.attachments.map(parseAttachment);
    if (parsed.some((attachment) => !attachment)) return undefined;
    attachments = parsed as ClientMinutesAttachment[];
  }
  return {
    id: value.id,
    source,
    title: value.title,
    content: value.content,
    ...optionalStrings,
    ...(attachments ? { attachments } : {}),
  };
}

export function parseMinutesResponse(value: unknown): MinutesResponse | undefined {
  if (!clean(value) || !Array.isArray(value.minutes)) return undefined;
  const minutes = value.minutes.map(parseItem);
  if (minutes.some((entry) => !entry)) return undefined;
  return { minutes: minutes as ClientMinutesItem[] };
}

export function parseMinutesContentResponse(value: unknown): ClientMinutesContent | undefined {
  if (!clean(value)) return undefined;
  return parseContent(value.minutes);
}
