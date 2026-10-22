/**
 * Envelope adapter — finds the A2UI payload inside whatever a producer returns.
 *
 * Producers answer in a few shapes: a bare message array, `{ a2ui: [...] }`,
 * a headless envelope `{ ok, data: { a2ui, input?, actions? } }`, or
 * `{ messages: [...] }`. The host normalizes them here so the store and the
 * app only ever see one shape. Optional `input` (an action that accepts typed
 * text) and `actions` (standalone action descriptors) ride along.
 */
import { parseActionDescriptor, type ActionDescriptor } from './actions.js';

export interface A2UIPayload {
  messages: unknown[];
  input: ActionDescriptor | null;
  actions: ActionDescriptor[];
  /** Where the messages were found, for diagnostics. */
  shape: 'array' | 'a2ui' | 'envelope' | 'messages' | 'snapshot' | 'none';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function actionsFrom(value: unknown): ActionDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseActionDescriptor)
    .filter((action): action is ActionDescriptor => action !== null);
}

const SNAPSHOT_ID = /^[a-z0-9][a-z0-9:_-]{0,80}$/u;

/**
 * Some producers mirror state as snapshots rather than message streams:
 * `{ catalogId, title, components, data }` (one surface) or
 * `{ surfaces: { <id>: snapshot } }` (several). Turn them into the equivalent
 * create/update messages so the store sees one protocol.
 */
export function snapshotToMessages(snapshot: unknown, fallbackId: string): unknown[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.components)) return [];
  const candidate = [snapshot.surfaceId, snapshot.catalogId, fallbackId].find(
    (value): value is string => typeof value === 'string' && SNAPSHOT_ID.test(value)
  );
  if (!candidate) return [];
  const catalogId =
    typeof snapshot.catalogId === 'string' && SNAPSHOT_ID.test(snapshot.catalogId)
      ? snapshot.catalogId
      : 'snapshot';
  const messages: unknown[] = [
    {
      createSurface: {
        surfaceId: candidate,
        catalogId,
        ...(typeof snapshot.title === 'string' ? { title: snapshot.title } : {}),
      },
    },
    { updateComponents: { surfaceId: candidate, components: snapshot.components } },
  ];
  if (isRecord(snapshot.data)) {
    messages.push({ updateDataModel: { surfaceId: candidate, data: snapshot.data } });
  }
  return messages;
}

function isSnapshot(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.components) && !('type' in value);
}

export function extractA2UIPayload(body: unknown): A2UIPayload {
  if (Array.isArray(body)) return { messages: body, input: null, actions: [], shape: 'array' };
  if (!isRecord(body)) return { messages: [], input: null, actions: [], shape: 'none' };

  if (isRecord(body.surfaces) && !Array.isArray(body.a2ui)) {
    const messages = Object.entries(body.surfaces).flatMap(([id, snapshot]) =>
      snapshotToMessages(snapshot, id)
    );
    if (messages.length) return { messages, input: null, actions: [], shape: 'snapshot' };
  }
  if (isSnapshot(body)) {
    const messages = snapshotToMessages(body, 'snapshot');
    if (messages.length) return { messages, input: null, actions: [], shape: 'snapshot' };
  }

  if (Array.isArray(body.a2ui)) {
    return {
      messages: body.a2ui,
      input: parseActionDescriptor(body.input),
      actions: actionsFrom(body.actions),
      shape: 'a2ui',
    };
  }
  const data = body.data;
  if (isRecord(data) && Array.isArray(data.a2ui)) {
    return {
      messages: data.a2ui,
      input: parseActionDescriptor(data.input),
      actions: actionsFrom(data.actions),
      shape: 'envelope',
    };
  }
  if (Array.isArray(data)) return { messages: data, input: null, actions: [], shape: 'envelope' };
  if (Array.isArray(body.messages)) {
    return {
      messages: body.messages,
      input: parseActionDescriptor(body.input),
      actions: actionsFrom(body.actions),
      shape: 'messages',
    };
  }
  return { messages: [], input: null, actions: [], shape: 'none' };
}
