import type { DiscussionApiResult, DiscussionCreateInput } from './discussion-client';

export const DISCUSSION_PENDING_PREFIX = 'kyberion.discussion.pending.v1.';
const ROUTING_KEYS = [
  'tenant',
  'organization_id',
  'project_id',
  'mission_id',
  'scope_digest',
] as const;
const SCOPE_DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type DiscussionRequestRouting = Partial<Record<(typeof ROUTING_KEYS)[number], string>>;
/** Digest binds the original scope snapshot, including absences. It is not authority. */
export type DiscussionCanonicalRouting = DiscussionRequestRouting & {
  tenant: string;
  scope_digest: string;
};
export interface DiscussionCreateHandle {
  version: 1;
  request_id: string;
  routing: DiscussionCanonicalRouting;
}
export interface DiscussionRecoveryState {
  phase:
    | 'loading'
    | 'resolving'
    | 'context-error'
    | 'invalid-input'
    | 'idle'
    | 'submitting'
    | 'checking'
    | 'unconfirmed'
    | 'created'
    | 'rejected'
    | 'storage-error';
  pending: DiscussionCreateHandle[];
  confirmedRoomId: string | null;
}
export type DiscussionRequestProof = { status: 'created'; roomId: string } | { status: 'rejected' };

type StorageLike = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
type RequestResult = DiscussionApiResult<unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function discussionRequestRouting(
  input: DiscussionRequestRouting
): DiscussionRequestRouting {
  const routing: DiscussionRequestRouting = {};
  for (const key of ROUTING_KEYS) {
    if (typeof input[key] === 'string' && input[key].trim()) routing[key] = input[key];
  }
  return routing;
}

function canonicalRouting(result: RequestResult): DiscussionCanonicalRouting | null {
  if (
    !result.ok ||
    result.status < 200 ||
    result.status >= 300 ||
    !isRecord(result.data) ||
    result.data.ok !== true ||
    !isRecord(result.data.routing)
  )
    return null;
  const routing = result.data.routing;
  if (
    typeof routing.tenant !== 'string' ||
    !routing.tenant.trim() ||
    typeof routing.scope_digest !== 'string' ||
    !SCOPE_DIGEST.test(routing.scope_digest) ||
    Object.entries(routing).some(
      ([key, value]) =>
        !ROUTING_KEYS.includes(key as (typeof ROUTING_KEYS)[number]) ||
        typeof value !== 'string' ||
        !value.trim()
    )
  )
    return null;
  return discussionRequestRouting(routing) as DiscussionCanonicalRouting;
}

function validCreateInput(input: DiscussionCreateInput): boolean {
  const integer = (value: unknown, min: number, max: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
  if (
    typeof input.goal !== 'string' ||
    !input.goal.trim() ||
    input.goal.trim().length > 2000 ||
    !['ja', 'en'].includes(input.locale) ||
    (input.mode !== undefined && !['panel', 'dialogue'].includes(input.mode)) ||
    !['auto', 'scripted', 'reasoning'].includes(input.speaker) ||
    (input.provider !== undefined && !['claude', 'codex'].includes(input.provider)) ||
    (input.speaker !== 'scripted' && !input.provider) ||
    (input.single_pass !== undefined && typeof input.single_pass !== 'boolean') ||
    (input.single_pass && input.mode === 'dialogue') ||
    !integer(input.turn_delay_ms, 0, 10_000) ||
    (input.max_rounds !== undefined && !integer(input.max_rounds, 1, 8)) ||
    (input.provider_timeout_ms !== undefined &&
      !integer(input.provider_timeout_ms, 1000, 60_000)) ||
    (input.max_provider_calls !== undefined &&
      (input.speaker === 'scripted'
        ? input.max_provider_calls !== 0
        : !integer(input.max_provider_calls, 1, 32)))
  )
    return false;
  return true;
}

/** Only a positive, matching receipt releases a pending request. HTTP errors never do. */
export function discussionRequestProof(
  handle: DiscussionCreateHandle,
  result: RequestResult
): DiscussionRequestProof | null {
  const body = result.data;
  if (
    !result.ok ||
    result.status < 200 ||
    result.status >= 300 ||
    !isRecord(body) ||
    body.ok !== true
  )
    return null;
  const request = body.request;
  if (!isRecord(request) || request.request_id !== handle.request_id) return null;
  if (
    request.status === 'created' &&
    typeof request.room_id === 'string' &&
    request.room_id &&
    isRecord(body.room) &&
    body.room.id === request.room_id &&
    request.reason === undefined
  ) {
    return { status: 'created', roomId: request.room_id };
  }
  if (
    request.status === 'rejected' &&
    request.reason === 'prerequisites_blocked' &&
    request.room_id === undefined &&
    body.room === undefined
  )
    return { status: 'rejected' };
  return null;
}

function parseHandle(value: string, key: string): DiscussionCreateHandle {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.request_id !== 'string' ||
    !UUID.test(parsed.request_id) ||
    key !== DISCUSSION_PENDING_PREFIX + parsed.request_id ||
    !isRecord(parsed.routing) ||
    typeof parsed.routing.tenant !== 'string' ||
    !parsed.routing.tenant.trim() ||
    typeof parsed.routing.scope_digest !== 'string' ||
    !SCOPE_DIGEST.test(parsed.routing.scope_digest) ||
    Object.keys(parsed).some((name) => !['version', 'request_id', 'routing'].includes(name)) ||
    Object.entries(parsed.routing).some(
      ([name, value]) =>
        !ROUTING_KEYS.includes(name as (typeof ROUTING_KEYS)[number]) ||
        typeof value !== 'string' ||
        !value.trim()
    )
  ) {
    throw new Error('Invalid recovery marker');
  }
  return {
    version: 1,
    request_id: parsed.request_id,
    routing: discussionRequestRouting(parsed.routing) as DiscussionCanonicalRouting,
  };
}

function readPending(storage: StorageLike): DiscussionCreateHandle[] {
  const handles: DiscussionCreateHandle[] = [];
  // Per-request keys preserve both handles if two tabs race. localStorage is NOT
  // a global transaction or exactly-once lock. The server owns scoped deduplication.
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key?.startsWith(DISCUSSION_PENDING_PREFIX)) continue;
    const value = storage.getItem(key);
    if (value === null) throw new Error('Recovery marker changed during read');
    handles.push(parseHandle(value, key));
  }
  return handles.sort((a, b) => a.request_id.localeCompare(b.request_id));
}

const matches = (left: DiscussionCreateHandle, right: DiscussionCreateHandle) =>
  left.request_id === right.request_id &&
  JSON.stringify(left.routing) === JSON.stringify(right.routing);

export function createDiscussionRecoveryController(options: {
  storage: () => StorageLike;
  uuid: () => string;
  context: (routing: DiscussionRequestRouting, signal: AbortSignal) => Promise<RequestResult>;
  post: (
    body: DiscussionCreateInput & { request_id: string },
    signal: AbortSignal
  ) => Promise<RequestResult>;
  lookup: (handle: DiscussionCreateHandle, signal: AbortSignal) => Promise<RequestResult>;
  onChange: (state: DiscussionRecoveryState) => void;
}) {
  let state: DiscussionRecoveryState = { phase: 'loading', pending: [], confirmedRoomId: null };
  let disposed = false;
  let inFlight = false;
  let abort: AbortController | null = null;
  const update = (next: DiscussionRecoveryState) => {
    if (disposed) return;
    state = next;
    options.onChange(state);
  };
  const storageFailure = () => update({ ...state, phase: 'storage-error' });
  const mergePending = (stored: DiscussionCreateHandle[], except?: string) => {
    const merged = new Map(
      state.pending.filter((h) => h.request_id !== except).map((h) => [h.request_id, h])
    );
    for (const handle of stored) {
      const previous = merged.get(handle.request_id);
      if (previous && !matches(previous, handle)) throw new Error('Recovery marker changed');
      merged.set(handle.request_id, handle);
    }
    return [...merged.values()];
  };
  const sync = () => {
    if (disposed) return false;
    try {
      const pending = mergePending(readPending(options.storage()));
      // Do not let an unrelated storage event turn an in-flight create into idle.
      update({
        ...state,
        pending,
        phase: inFlight ? state.phase : pending.length ? 'unconfirmed' : 'idle',
      });
      return true;
    } catch {
      storageFailure();
      return false;
    }
  };
  const apply = (handle: DiscussionCreateHandle, result: RequestResult) => {
    const proof = discussionRequestProof(handle, result);
    if (!proof || disposed) return false;
    try {
      const storage = options.storage();
      const key = DISCUSSION_PENDING_PREFIX + handle.request_id;
      const raw = storage.getItem(key);
      if (raw !== null) {
        if (!matches(parseHandle(raw, key), handle)) throw new Error('Recovery marker changed');
        storage.removeItem(key);
        if (storage.getItem(key) !== null) throw new Error('Recovery marker was not removed');
      }
      const pending = mergePending(readPending(storage), handle.request_id);
      update({
        phase: pending.length ? 'unconfirmed' : proof.status,
        pending,
        confirmedRoomId: proof.status === 'created' ? proof.roomId : state.confirmedRoomId,
      });
      return true;
    } catch {
      storageFailure();
      return false;
    }
  };
  const lookup = async (handle: DiscussionCreateHandle) => {
    abort = new AbortController();
    update({ ...state, phase: 'checking' });
    try {
      const result = await options.lookup(handle, abort.signal);
      if (!disposed && !apply(handle, result) && state.phase !== 'storage-error')
        update({ ...state, phase: 'unconfirmed' });
    } catch {
      if (!disposed) update({ ...state, phase: 'unconfirmed' });
    } finally {
      abort = null;
    }
  };
  return {
    getState: () => state,
    sync,
    async check(requestId?: string) {
      if (disposed || inFlight || !sync() || !state.pending.length) return;
      const handle = requestId
        ? state.pending.find((entry) => entry.request_id === requestId)
        : state.pending[0];
      if (!handle) return;
      inFlight = true;
      try {
        await lookup(handle);
      } finally {
        inFlight = false;
      }
    },
    async start(input: DiscussionCreateInput): Promise<RequestResult | null> {
      if (disposed || inFlight || !sync() || state.pending.length) return null;
      // Freeze intent before the read-only context await. Context receives no goal.
      const snapshot = Object.freeze({ ...input });
      if (!validCreateInput(snapshot)) {
        update({ ...state, phase: 'invalid-input' });
        return null;
      }
      inFlight = true;
      try {
        abort = new AbortController();
        update({ ...state, phase: 'resolving', confirmedRoomId: null });
        let contextResult: RequestResult;
        try {
          const originalRouting = discussionRequestRouting(snapshot);
          delete originalRouting.scope_digest;
          contextResult = await options.context(originalRouting, abort.signal);
        } catch {
          contextResult = { ok: false, status: 0, data: null };
        }
        abort = null;
        if (disposed) return null;
        const routing = canonicalRouting(contextResult);
        if (!routing) {
          update({ ...state, phase: 'context-error' });
          return null;
        }
        let handle: DiscussionCreateHandle;
        try {
          const storage = options.storage();
          const existing = mergePending(readPending(storage));
          if (existing.length) {
            update({ ...state, phase: 'unconfirmed', pending: existing });
            return null;
          }
          const request_id = options.uuid();
          if (!UUID.test(request_id)) throw new Error('UUID unavailable');
          handle = { version: 1, request_id, routing };
          const key = DISCUSSION_PENDING_PREFIX + request_id;
          storage.setItem(key, JSON.stringify(handle));
          const saved = storage.getItem(key);
          if (!saved || !matches(parseHandle(saved, key), handle))
            throw new Error('Recovery persistence failed');
          update({ phase: 'submitting', pending: readPending(storage), confirmedRoomId: null });
        } catch {
          storageFailure();
          return null;
        }
        abort = new AbortController();
        let result: RequestResult;
        try {
          const body = { ...snapshot, ...handle.routing, request_id: handle.request_id };
          for (const key of ROUTING_KEYS) if (handle.routing[key] === undefined) delete body[key];
          result = await options.post(body, abort.signal);
        } catch {
          result = { ok: false, status: 0, data: null };
        }
        abort = null;
        if (disposed) return result;
        if (!apply(handle, result) && state.phase !== 'storage-error') {
          update({ ...state, phase: 'unconfirmed' });
          await lookup(handle);
        }
        return result;
      } finally {
        inFlight = false;
      }
    },
    dispose() {
      disposed = true;
      abort?.abort();
      // Keep the durable marker: HTTP abort does not cancel the backend/provider.
    },
  };
}

export function discussionCreationBlocked(state: DiscussionRecoveryState): boolean {
  return (
    state.pending.length > 0 ||
    ['loading', 'resolving', 'submitting', 'checking', 'storage-error'].includes(state.phase)
  );
}
