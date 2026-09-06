import { isRecord } from '@agent/core/foundation/primitives';

export type ClientAgentChatMessage = Record<string, unknown>;

export type ClientAgentChatSuccessResponse = {
  status: 'ok' | 'warning';
  response: string;
  a2ui?: ClientAgentChatMessage[];
  timestamp: string;
  traceId?: string;
  correlationId?: string;
};

export type ClientAgentChatErrorResponse = {
  error?: string;
  errorCode?: string;
  correlationId?: string;
  traceId?: string;
  title?: string;
  body?: string;
  nextAction?: string;
  traceLine?: string;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SUCCESS_STATUSES = new Set(['ok', 'warning']);
const A2UI_COMPONENT_TYPES = new Set([
  'text',
  'button',
  'card',
  'container',
  'display:hero',
  'display:badges',
  'display:section',
  'display:gauge',
  'display:log',
  'display:table',
  'display:status',
  'display:kv',
  'display:metric',
  'display:metrics-row',
  'display:timeline',
  'display:progress',
  'display:alert',
  'display:code',
  'display:list',
  'display:card',
  'display:grid',
  'display:donut',
  'display:bar-chart',
  'display:stacked-bar',
  'display:sparkline',
  'kb-layout-grid',
  'kb-status-orbit',
  'kb-mission-card',
  'kb-artifact-tile',
  'kb-intervention-panel',
  'presence.status',
  'presence.subtitle',
  'presence.transcript',
  'presence.avatar',
]);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function string(value: unknown): value is string {
  return typeof value === 'string';
}

function nonEmptyString(value: unknown): value is string {
  return string(value) && Boolean(value.trim());
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || string(value);
}

function parseA2uiComponent(value: unknown): ClientAgentChatMessage | undefined {
  if (!isRecord(value) || !nonEmptyString(value.id) || !nonEmptyString(value.type)) {
    return undefined;
  }
  if (
    !A2UI_COMPONENT_TYPES.has(value.type) ||
    !isRecord(value.props) ||
    !hasSafeTree(value.props)
  ) {
    return undefined;
  }
  if (
    Object.hasOwn(value, 'children') &&
    (!Array.isArray(value.children) || value.children.some((child) => typeof child !== 'string'))
  ) {
    return undefined;
  }
  return {
    id: value.id,
    type: value.type,
    props: value.props,
    ...(Array.isArray(value.children) ? { children: value.children } : {}),
  };
}

function parseA2uiSurfaceMessage(value: unknown): ClientAgentChatMessage | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  const operations = [
    'createSurface',
    'updateComponents',
    'updateDataModel',
    'deleteSurface',
  ].filter((key) => Object.hasOwn(value, key));
  if (operations.length !== 1) return undefined;

  const operation = operations[0];
  if (operation === 'createSurface') {
    const create = value.createSurface;
    if (
      !isRecord(create) ||
      !nonEmptyString(create.surfaceId) ||
      !nonEmptyString(create.catalogId)
    ) {
      return undefined;
    }
    if (
      (Object.hasOwn(create, 'title') && !optionalString(create.title)) ||
      (Object.hasOwn(create, 'titleKey') && !optionalString(create.titleKey))
    ) {
      return undefined;
    }
    return {
      createSurface: {
        surfaceId: create.surfaceId,
        catalogId: create.catalogId,
        ...(create.title !== undefined ? { title: create.title } : {}),
        ...(create.titleKey !== undefined ? { titleKey: create.titleKey } : {}),
      },
    };
  }

  if (operation === 'updateComponents') {
    const update = value.updateComponents;
    if (
      !isRecord(update) ||
      !nonEmptyString(update.surfaceId) ||
      !Array.isArray(update.components)
    ) {
      return undefined;
    }
    const components = update.components.map(parseA2uiComponent);
    if (components.some((component) => !component)) return undefined;
    return { updateComponents: { surfaceId: update.surfaceId, components } };
  }

  if (operation === 'updateDataModel') {
    const update = value.updateDataModel;
    if (!isRecord(update) || !nonEmptyString(update.surfaceId) || !isRecord(update.data)) {
      return undefined;
    }
    return { updateDataModel: { surfaceId: update.surfaceId, data: update.data } };
  }

  const deletion = value.deleteSurface;
  return isRecord(deletion) && nonEmptyString(deletion.surfaceId)
    ? { deleteSurface: { surfaceId: deletion.surfaceId } }
    : undefined;
}

function parseA2uiMessage(value: unknown): ClientAgentChatMessage | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  const surfaceOperations = [
    'createSurface',
    'updateComponents',
    'updateDataModel',
    'deleteSurface',
  ];
  if (surfaceOperations.some((key) => Object.hasOwn(value, key))) {
    return parseA2uiSurfaceMessage(value);
  }
  if (!nonEmptyString(value.type) || !A2UI_COMPONENT_TYPES.has(value.type)) return undefined;
  if (Object.hasOwn(value, 'id') && !nonEmptyString(value.id)) return undefined;
  if (Object.hasOwn(value, 'props') && (!isRecord(value.props) || !hasSafeTree(value.props))) {
    return undefined;
  }
  return {
    type: value.type,
    ...(value.id !== undefined ? { id: value.id } : {}),
    ...(value.props !== undefined ? { props: value.props } : {}),
  };
}

function parseA2ui(value: unknown): ClientAgentChatMessage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parseA2uiMessage);
  return parsed.every((message): message is ClientAgentChatMessage => message !== undefined)
    ? parsed
    : undefined;
}

export function parseAgentChatSuccessResponse(
  value: unknown
): ClientAgentChatSuccessResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    typeof value.status !== 'string' ||
    !SUCCESS_STATUSES.has(value.status) ||
    !nonEmptyString(value.response) ||
    !nonEmptyString(value.timestamp) ||
    !optionalString(value.traceId) ||
    !optionalString(value.correlationId)
  ) {
    return undefined;
  }
  const a2ui = parseA2ui(value.a2ui);
  if (value.a2ui !== undefined && !a2ui) return undefined;
  return {
    status: value.status as ClientAgentChatSuccessResponse['status'],
    response: value.response,
    ...(a2ui !== undefined ? { a2ui } : {}),
    timestamp: value.timestamp,
    ...(value.traceId !== undefined ? { traceId: value.traceId } : {}),
    ...(value.correlationId !== undefined ? { correlationId: value.correlationId } : {}),
  };
}

export function parseAgentChatErrorResponse(
  value: unknown
): ClientAgentChatErrorResponse | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  if (
    !optionalString(value.error) ||
    !optionalString(value.errorCode) ||
    !optionalString(value.correlationId) ||
    !optionalString(value.traceId) ||
    !optionalString(value.title) ||
    !optionalString(value.body) ||
    !optionalString(value.nextAction) ||
    !optionalString(value.traceLine)
  ) {
    return undefined;
  }
  if (![value.error, value.body, value.title].some(nonEmptyString)) return undefined;
  return {
    ...(value.error !== undefined ? { error: value.error } : {}),
    ...(value.errorCode !== undefined ? { errorCode: value.errorCode } : {}),
    ...(value.correlationId !== undefined ? { correlationId: value.correlationId } : {}),
    ...(value.traceId !== undefined ? { traceId: value.traceId } : {}),
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.body !== undefined ? { body: value.body } : {}),
    ...(value.nextAction !== undefined ? { nextAction: value.nextAction } : {}),
    ...(value.traceLine !== undefined ? { traceLine: value.traceLine } : {}),
  };
}
