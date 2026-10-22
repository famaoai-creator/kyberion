/**
 * A2UI wire contract as seen by the host framework.
 *
 * The canonical protocol lives in `@agent/core/a2ui` (server side). The host
 * runs in the browser as well, so it carries its own dependency-free parser
 * that mirrors the same structural rules: exactly one operation per message,
 * safe identifiers, components as `{ id, type, props, children? }`. Types are
 * shared with the core contract (type-only import, erased at build time).
 */
import type { A2UIComponent, A2UIDataModel, A2UIMessage } from '@agent/core/a2ui';

export type { A2UIComponent, A2UIDataModel, A2UIMessage };

/** Identifier rule shared with the core contract (surface ids, component ids). */
export const A2UI_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,80}$/u;
/** Component type rule shared with the core contract. */
export const A2UI_TYPE_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,80}$/u;

export type A2UIOperationName =
  'createSurface' | 'updateComponents' | 'updateDataModel' | 'deleteSurface';

export const A2UI_OPERATIONS: readonly A2UIOperationName[] = [
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
];

export class A2UIProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2UIProtocolError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new A2UIProtocolError(`${label} contains unknown field: ${unknown}`);
}

/** Return the single operation carried by a message, or throw. */
export function operationOf(message: A2UIMessage): A2UIOperationName {
  const present = A2UI_OPERATIONS.filter((name) => message[name] !== undefined);
  if (present.length !== 1)
    throw new A2UIProtocolError('message must contain exactly one operation');
  return present[0];
}

/** Surface id addressed by a message. */
export function surfaceIdOf(message: A2UIMessage): string {
  const operation = operationOf(message);
  return (message[operation] as { surfaceId: string }).surfaceId;
}

/**
 * Structural validation of one A2UI message. Throws `A2UIProtocolError` with
 * a short reason; never mutates the input. Component `props` are opaque here —
 * the renderer decides what each component type accepts.
 */
export function parseA2UIMessage(value: unknown): A2UIMessage {
  if (!isRecord(value)) throw new A2UIProtocolError('message must be an object');
  assertKnownKeys(value, A2UI_OPERATIONS, 'message');
  const present = A2UI_OPERATIONS.filter((name) => value[name] !== undefined);
  if (present.length !== 1)
    throw new A2UIProtocolError('message must contain exactly one operation');
  const operation = present[0];
  const payload = value[operation];
  if (!isRecord(payload)) throw new A2UIProtocolError(`${operation} payload must be an object`);

  const allowedKeys: Record<A2UIOperationName, readonly string[]> = {
    createSurface: ['surfaceId', 'catalogId', 'title', 'titleKey'],
    updateComponents: ['surfaceId', 'components'],
    updateDataModel: ['surfaceId', 'data'],
    deleteSurface: ['surfaceId'],
  };
  assertKnownKeys(payload, allowedKeys[operation], `${operation} payload`);
  if (typeof payload.surfaceId !== 'string' || !A2UI_ID_PATTERN.test(payload.surfaceId)) {
    throw new A2UIProtocolError('surfaceId is invalid');
  }

  if (operation === 'createSurface') {
    if (typeof payload.catalogId !== 'string' || !A2UI_ID_PATTERN.test(payload.catalogId)) {
      throw new A2UIProtocolError('catalogId is invalid');
    }
    if (payload.title !== undefined && typeof payload.title !== 'string') {
      throw new A2UIProtocolError('title must be a string');
    }
    if (payload.titleKey !== undefined && typeof payload.titleKey !== 'string') {
      throw new A2UIProtocolError('titleKey must be a string');
    }
  } else if (operation === 'updateComponents') {
    if (!Array.isArray(payload.components))
      throw new A2UIProtocolError('components must be an array');
    payload.components.forEach((component) => parseA2UIComponent(component));
  } else if (operation === 'updateDataModel') {
    if (!isRecord(payload.data)) throw new A2UIProtocolError('data model must be an object');
  }
  return value as A2UIMessage;
}

/** Structural validation of one component. */
export function parseA2UIComponent(value: unknown): A2UIComponent {
  if (!isRecord(value)) throw new A2UIProtocolError('component must be an object');
  assertKnownKeys(value, ['id', 'type', 'props', 'children'], 'component');
  if (typeof value.id !== 'string' || !A2UI_ID_PATTERN.test(value.id)) {
    throw new A2UIProtocolError('component id is invalid');
  }
  if (typeof value.type !== 'string' || !A2UI_TYPE_PATTERN.test(value.type)) {
    throw new A2UIProtocolError(`component type is invalid: ${String(value.id)}`);
  }
  if (!isRecord(value.props))
    throw new A2UIProtocolError(`component props must be an object: ${value.id}`);
  if (value.children !== undefined) {
    if (
      !Array.isArray(value.children) ||
      value.children.some((child) => typeof child !== 'string')
    ) {
      throw new A2UIProtocolError(`component children must be an array of ids: ${value.id}`);
    }
  }
  return value as unknown as A2UIComponent;
}

/**
 * Inline child component (a component object nested under `props.items`
 * without its own id). Several producers emit this compact form; the host
 * accepts it alongside canonical `children` id references.
 */
export interface InlineComponent {
  type: string;
  props: A2UIDataModel;
}

export function isInlineComponent(value: unknown): value is InlineComponent {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    A2UI_TYPE_PATTERN.test(value.type) &&
    isRecord(value.props)
  );
}
