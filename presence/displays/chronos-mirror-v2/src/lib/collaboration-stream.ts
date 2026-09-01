import { parseEventScopeFromRecord, type OsKnowledgeTier } from '@agent/core/event-scope';
import { BoundedRingBuffer, CE_STREAM_LIMITS } from '@agent/core/ce-adoption';
import type { WorkerEventEnvelope } from '@agent/core/worker-event-stream';

export interface CollaborationStreamEvent {
  id: string;
  type: string;
  ts: string;
  mission_id?: string;
  task_id?: string;
  agent_id?: string;
  trace_id?: string;
  artifact_path?: string;
  payload: Record<string, unknown>;
}

/**
 * Worker-event records from before scope propagation may only carry a mission
 * id in the envelope source. Callers must supply the authoritative mission
 * tier for that legacy shape; an absent or malformed tier is not visible.
 */
export function collaborationEventVisibleToTier(
  payload: Record<string, unknown>,
  fallbackTier: OsKnowledgeTier | undefined,
  tierAccess: readonly OsKnowledgeTier[]
): boolean {
  const parsed = parseEventScopeFromRecord(payload);
  if (parsed.invalid) return false;
  // A caller-supplied fallback is authoritative when available. Persisted
  // payload metadata must not be able to relabel a confidential mission as
  // public and bypass the viewer tier boundary.
  const tier = fallbackTier || parsed.scope?.tier;
  return Boolean(tier && tierAccess.includes(tier));
}

export function normalizeWorkerEvent(
  event: WorkerEventEnvelope,
  id: string
): CollaborationStreamEvent {
  const payload = (event.payload || {}) as Record<string, unknown>;
  const trace_id = typeof payload.trace_id === 'string' ? payload.trace_id : undefined;
  const artifact_path =
    typeof payload.artifact_path === 'string' ? payload.artifact_path : undefined;
  return {
    id,
    type: event.type,
    ts: event.ts,
    ...(event.source?.mission_id ? { mission_id: event.source.mission_id } : {}),
    ...(event.source?.task_id ? { task_id: event.source.task_id } : {}),
    ...(event.source?.agent_id ? { agent_id: event.source.agent_id } : {}),
    ...(trace_id ? { trace_id } : {}),
    ...(artifact_path ? { artifact_path } : {}),
    payload,
  };
}

const DEFAULT_WINDOWS: Record<string, number> = {
  status_update: 100,
  notification: 150,
  step_begin: 150,
  step_end: 150,
};

/** CE-02: first event is immediate; follow-ups of the same type are merged. */
export class CollaborationEventBatcher {
  private readonly queues = new Map<string, BoundedRingBuffer<CollaborationStreamEvent>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly emit: (events: CollaborationStreamEvent[]) => void,
    private readonly schedule: (
      callback: () => void,
      delayMs: number
    ) => ReturnType<typeof setTimeout> = (callback, delayMs) => setTimeout(callback, delayMs),
    private readonly cancel: (handle: ReturnType<typeof setTimeout>) => void = (handle) =>
      clearTimeout(handle)
  ) {}

  push(event: CollaborationStreamEvent): void {
    const queue =
      this.queues.get(event.type) ||
      new BoundedRingBuffer<CollaborationStreamEvent>(CE_STREAM_LIMITS.maxSseQueue);
    const wasEmpty = queue.size === 0;
    queue.push(event);
    this.queues.set(event.type, queue);
    if (wasEmpty && !this.timers.has(event.type)) {
      this.emit([event]);
      queue.clear();
      const timer = this.schedule(() => {
        this.timers.delete(event.type);
        const pending = this.queues.get(event.type);
        this.queues.delete(event.type);
        if (pending && pending.size > 0) this.emit(pending.toArray());
      }, DEFAULT_WINDOWS[event.type] ?? 200);
      this.timers.set(event.type, timer);
    }
  }

  flush(): void {
    this.timers.forEach((timer, type) => {
      this.cancel(timer);
      this.timers.delete(type);
    });
    this.queues.forEach((queue) => {
      if (queue.size > 0) this.emit(queue.toArray());
    });
    this.queues.clear();
  }
}
