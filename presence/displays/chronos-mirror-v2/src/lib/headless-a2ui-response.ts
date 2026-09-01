import { isRecord } from '@agent/core/foundation';

export type HeadlessA2UIComponent = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: string[];
};

export type HeadlessA2UIResponse = {
  ok: true;
  data: {
    a2ui: {
      updateComponents: {
        surfaceId: string;
        components: HeadlessA2UIComponent[];
      };
    };
  };
};

type JsonRecord = Record<string, unknown>;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseJsonValue(value: unknown): unknown | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const parsed = value.map(parseJsonValue);
    return parsed.every((entry) => entry !== undefined) ? parsed : undefined;
  }
  if (!isRecord(value) || Object.keys(value).some((key) => DANGEROUS_KEYS.has(key)))
    return undefined;
  const parsed: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = parseJsonValue(entry);
    if (next === undefined) return undefined;
    parsed[key] = next;
  }
  return parsed;
}

function requiredString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseComponent(value: unknown): HeadlessA2UIComponent | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredString(value, 'id');
  const type = requiredString(value, 'type');
  if (!id || !type || !isRecord(value.props)) return undefined;
  const props = parseJsonValue(value.props);
  if (!isRecord(props)) return undefined;
  if (value.children !== undefined) {
    if (!Array.isArray(value.children) || value.children.some((child) => typeof child !== 'string'))
      return undefined;
    return { id, type, props, children: value.children };
  }
  return { id, type, props };
}

export function parseHeadlessA2UIResponse(value: unknown): HeadlessA2UIResponse | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined;
  const data = isRecord(value.data) ? value.data : undefined;
  const a2ui = data && isRecord(data.a2ui) ? data.a2ui : undefined;
  const updateComponents =
    a2ui && isRecord(a2ui.updateComponents) ? a2ui.updateComponents : undefined;
  if (!updateComponents || !Array.isArray(updateComponents.components)) return undefined;
  const surfaceId = requiredString(updateComponents, 'surfaceId');
  const components = updateComponents.components.map(parseComponent);
  if (!surfaceId || components.some((component) => !component)) return undefined;
  return {
    ok: true,
    data: {
      a2ui: {
        updateComponents: {
          surfaceId,
          components: components as HeadlessA2UIComponent[],
        },
      },
    },
  };
}
