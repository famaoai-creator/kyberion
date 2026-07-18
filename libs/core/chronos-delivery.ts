import { enqueueSurfaceOutboxMessage } from './surface-coordination-store.js';
import type { SurfaceAsyncChannel } from './channel-surface-types.js';

const ALLOWED_DELIVERY_SURFACES = new Set(['slack', 'telegram', 'discord', 'imessage']);
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu;

export interface ChronosDeliveryTarget {
  surface: SurfaceAsyncChannel;
  channel: string;
  thread_ts?: string;
  template?: string;
}

export interface ChronosDeliveryInput {
  scheduleId: string;
  pipelineName: string;
  runId: string;
  status: 'succeeded' | 'failed';
  context?: Record<string, unknown>;
  target: ChronosDeliveryTarget;
}

function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function resolvePath(root: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, root);
}

export function validateChronosDeliveryTarget(
  target: ChronosDeliveryTarget
): ChronosDeliveryTarget {
  const surface = String(target.surface || '')
    .trim()
    .toLowerCase();
  const channel = String(target.channel || '').trim();
  const threadTs = String(target.thread_ts || '').trim();
  const template = target.template === undefined ? undefined : String(target.template);
  if (!ALLOWED_DELIVERY_SURFACES.has(surface)) {
    throw new Error(`[POLICY_VIOLATION] Unsupported Chronos delivery surface: ${surface}`);
  }
  if (!channel || channel.length > 500 || channel.includes('\u0000')) {
    throw new Error('[POLICY_VIOLATION] Chronos delivery channel must be bounded and non-empty.');
  }
  if (threadTs.length > 500 || threadTs.includes('\u0000')) {
    throw new Error('[POLICY_VIOLATION] Chronos delivery thread_ts is invalid.');
  }
  if (template !== undefined && (template.length === 0 || template.length > 8_000)) {
    throw new Error('[POLICY_VIOLATION] Chronos delivery template must be 1-8000 characters.');
  }
  return {
    surface,
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(template === undefined ? {} : { template }),
  };
}

export function renderChronosDeliveryMessage(input: {
  scheduleId: string;
  pipelineName: string;
  status: 'succeeded' | 'failed';
  context?: Record<string, unknown>;
  template?: string;
}): string {
  const values: Record<string, unknown> = {
    schedule_id: input.scheduleId,
    pipeline_name: input.pipelineName,
    status: input.status,
    context: input.context || {},
  };
  const template =
    input.template || 'Scheduled pipeline "{{pipeline_name}}" completed with status {{status}}.';
  const rendered = template.replace(PLACEHOLDER_PATTERN, (_match, key: string) =>
    text(resolvePath(values, key), `{{${key}}}`)
  );
  return rendered.trim();
}

/** Enqueue one validated schedule result directly into the selected surface outbox. */
export function enqueueChronosDelivery(input: ChronosDeliveryInput): string {
  const scheduleId = String(input.scheduleId || '').trim();
  const pipelineName = String(input.pipelineName || '').trim();
  const runId = String(input.runId || '').trim();
  if (!scheduleId || !pipelineName || !runId) {
    throw new Error('scheduleId, pipelineName, and runId are required for Chronos delivery.');
  }
  const target = validateChronosDeliveryTarget(input.target);
  const rendered = renderChronosDeliveryMessage({
    scheduleId,
    pipelineName,
    status: input.status,
    context: input.context,
    template: target.template,
  });
  if (!rendered) throw new Error('[POLICY_VIOLATION] Chronos delivery rendered an empty message.');
  return enqueueSurfaceOutboxMessage({
    surface: target.surface,
    correlationId: `chronos:${scheduleId}:${runId}`,
    channel: target.channel,
    // An empty thread_ts means “post to the channel”. Using the channel id as
    // a thread timestamp makes Slack attempt to reply to a nonexistent thread.
    threadTs: target.thread_ts || '',
    text: rendered,
    source: 'system',
    // A daemon retry for the same claimed run must reuse the existing outbox
    // record instead of creating a second provider delivery.
    deduplicationKey: `chronos:${scheduleId}:${runId}`,
  });
}
