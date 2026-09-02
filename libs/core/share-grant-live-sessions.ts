import { pathResolver } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { safeExistsSync, safeFsyncFile, safeWriteFile } from './secure-io.js';
import { withLockSync } from './src/lock-utils.js';
import type {
  ShareGrantLiveSessionEvictionRequest,
  ShareGrantLiveSessionEvictionResult,
  ShareGrantLiveSessionEvictor,
  ShareGrantLiveSessionRegistration,
  ShareGrantLiveSessionSummary,
} from './share-grant-graph.js';

export const SHARE_GRANT_LIVE_SESSIONS_PATH = pathResolver.shared(
  'runtime/share-grant-live-sessions.json'
);

export interface ShareGrantLiveSessionRegistryOptions {
  storePath?: string;
  persist?: boolean;
}

interface PersistedLiveSessionState {
  version: 1;
  sessions: ShareGrantLiveSessionRegistration[];
  revokedScopes: string[];
}

export class ShareGrantLiveSessionValidationError extends Error {
  constructor(message: string) {
    super(`[share-grant-live-sessions] ${message}`);
    this.name = 'ShareGrantLiveSessionValidationError';
  }
}

function required(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new ShareGrantLiveSessionValidationError(`${label} is required`);
  if (normalized.length > 512) {
    throw new ShareGrantLiveSessionValidationError(`${label} exceeds the 512-character limit`);
  }
  return normalized;
}

function requiredTimestamp(value: unknown, label: string): string {
  const normalized = required(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new ShareGrantLiveSessionValidationError(`${label} must be a valid timestamp`);
  }
  return normalized;
}

const LIVE_SESSION_STATE_FIELDS = ['version', 'sessions', 'revokedScopes'] as const;
const LIVE_SESSION_FIELDS = ['sessionId', 'linkId', 'resourceRef', 'connectedAt'] as const;

function parsePersistedLiveSessionState(value: unknown): PersistedLiveSessionState {
  const root = parseSafeJsonObjectValue(value, 'live-session state');
  const allowedRootFields = new Set<string>(LIVE_SESSION_STATE_FIELDS);
  if (Object.keys(root).some((key) => !allowedRootFields.has(key))) {
    throw new ShareGrantLiveSessionValidationError('live-session state contains unknown fields');
  }
  if (root.version !== 1) {
    throw new ShareGrantLiveSessionValidationError('live-session state has an invalid version');
  }
  if (!Array.isArray(root.sessions) || !Array.isArray(root.revokedScopes)) {
    throw new ShareGrantLiveSessionValidationError('live-session state has an invalid schema');
  }

  const revokedScopeKeys = new Set<string>();
  const revokedScopes = root.revokedScopes.map((scope, index) => {
    if (typeof scope !== 'string' || scope.trim() === '' || !scope.includes('\u0000')) {
      throw new ShareGrantLiveSessionValidationError(
        `revokedScopes[${index}] must be a valid link/resource scope`
      );
    }
    const parts = scope.split('\u0000');
    if (parts.length !== 2) {
      throw new ShareGrantLiveSessionValidationError(
        `revokedScopes[${index}] must contain one link/resource separator`
      );
    }
    const normalized = scopeKey(
      required(parts[0], `revokedScopes[${index}].linkId`),
      required(parts[1], `revokedScopes[${index}].resourceRef`)
    );
    if (normalized !== scope || revokedScopeKeys.has(normalized)) {
      throw new ShareGrantLiveSessionValidationError(
        `revokedScopes[${index}] must be canonical and unique`
      );
    }
    revokedScopeKeys.add(normalized);
    return normalized;
  });

  const sessionIds = new Set<string>();
  const sessions = root.sessions.map((candidate, index) => {
    const record = parseSafeJsonObjectValue(candidate, `live-session state sessions[${index}]`);
    const allowedSessionFields = new Set<string>(LIVE_SESSION_FIELDS);
    if (Object.keys(record).some((key) => !allowedSessionFields.has(key))) {
      throw new ShareGrantLiveSessionValidationError(`sessions[${index}] contains unknown fields`);
    }
    const session = {
      sessionId: required(record.sessionId, `session[${index}].sessionId`),
      linkId: required(record.linkId, `session[${index}].linkId`),
      resourceRef: required(record.resourceRef, `session[${index}].resourceRef`),
      connectedAt: requiredTimestamp(record.connectedAt, `session[${index}].connectedAt`),
    };
    if (sessionIds.has(session.sessionId)) {
      throw new ShareGrantLiveSessionValidationError(`session[${index}].sessionId is duplicated`);
    }
    sessionIds.add(session.sessionId);
    return session;
  });

  return { version: 1, sessions, revokedScopes };
}

/**
 * Shared runtime registry for sessions established through a share link.
 *
 * The resolver that authenticated a share token owns registration. This
 * registry intentionally stores no token or viewer data; it only provides a
 * narrow revocation boundary for the share-grant graph.
 */
export class ShareGrantLiveSessionRegistry implements ShareGrantLiveSessionEvictor {
  readonly #storePath: string;
  readonly #persist: boolean;
  readonly #sessions = new Map<string, ShareGrantLiveSessionRegistration>();
  readonly #revokedScopes = new Set<string>();

  constructor(options: ShareGrantLiveSessionRegistryOptions = {}) {
    this.#storePath = options.storePath ?? SHARE_GRANT_LIVE_SESSIONS_PATH;
    this.#persist = options.persist ?? false;
    if (this.#persist) this.#load();
  }

  registerShareLinkSession(input: ShareGrantLiveSessionRegistration): ShareGrantLiveSessionSummary {
    const session = {
      sessionId: required(input.sessionId, 'sessionId'),
      linkId: required(input.linkId, 'linkId'),
      resourceRef: required(input.resourceRef, 'resourceRef'),
      connectedAt: requiredTimestamp(input.connectedAt, 'connectedAt'),
    };
    return this.#mutate(() => {
      if (this.#revokedScopes.has(scopeKey(session.linkId, session.resourceRef))) {
        throw new ShareGrantLiveSessionValidationError(
          `share-link ${session.linkId} has already been revoked`
        );
      }
      const existing = this.#sessions.get(session.sessionId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(session)) {
        throw new ShareGrantLiveSessionValidationError(
          `session ${session.sessionId} is already registered with different link scope`
        );
      }
      this.#sessions.set(session.sessionId, session);
      return { ...session };
    });
  }

  disconnect(sessionId: string): boolean {
    const normalized = required(sessionId, 'sessionId');
    return this.#mutate(() => this.#sessions.delete(normalized));
  }

  listActive(input?: { linkId?: string; resourceRef?: string }): ShareGrantLiveSessionSummary[] {
    const linkId = input?.linkId?.trim();
    const resourceRef = input?.resourceRef?.trim();
    return this.#read(() =>
      [...this.#sessions.values()]
        .filter(
          (session) =>
            (!linkId || session.linkId === linkId) &&
            (!resourceRef || session.resourceRef === resourceRef)
        )
        .map((session) => ({ ...session }))
    );
  }

  evictShareLinkSessions(
    input: ShareGrantLiveSessionEvictionRequest
  ): ShareGrantLiveSessionEvictionResult {
    const linkId = required(input.linkId, 'linkId');
    const resourceRef = required(input.resourceRef, 'resourceRef');
    requiredTimestamp(input.revokedAt, 'revokedAt');
    return this.#mutate(() => {
      this.#revokedScopes.add(scopeKey(linkId, resourceRef));
      const evictedSessionIds: string[] = [];
      for (const [sessionId, session] of this.#sessions) {
        if (session.linkId !== linkId || session.resourceRef !== resourceRef) continue;
        this.#sessions.delete(sessionId);
        evictedSessionIds.push(sessionId);
      }
      return { evictedSessionIds };
    });
  }

  #read<T>(fn: () => T): T {
    if (!this.#persist) return fn();
    return withLockSync('share-grant-live-sessions', () => {
      this.#load();
      return fn();
    });
  }

  #mutate<T>(fn: () => T): T {
    if (!this.#persist) return fn();
    return withLockSync('share-grant-live-sessions', () => {
      this.#load();
      const result = fn();
      this.#persistState();
      return result;
    });
  }

  #load(): void {
    if (!safeExistsSync(this.#storePath)) return;
    let parsed: PersistedLiveSessionState;
    try {
      parsed = parsePersistedLiveSessionState(readJson<unknown>(this.#storePath));
    } catch (error) {
      if (error instanceof ShareGrantLiveSessionValidationError) throw error;
      throw new ShareGrantLiveSessionValidationError(
        `live-session state could not be read: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const revokedScopes = new Set(parsed.revokedScopes);
    const sessions = new Map<string, ShareGrantLiveSessionRegistration>();
    for (const session of parsed.sessions) {
      const normalized = {
        sessionId: session.sessionId,
        linkId: session.linkId,
        resourceRef: session.resourceRef,
        connectedAt: session.connectedAt,
      };
      if (revokedScopes.has(scopeKey(normalized.linkId, normalized.resourceRef))) {
        continue;
      }
      sessions.set(normalized.sessionId, normalized);
    }
    this.#sessions.clear();
    this.#revokedScopes.clear();
    for (const scope of revokedScopes) this.#revokedScopes.add(scope);
    for (const [sessionId, session] of sessions) this.#sessions.set(sessionId, session);
  }

  #persistState(): void {
    safeWriteFile(
      this.#storePath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: [...this.#sessions.values()],
          revokedScopes: [...this.#revokedScopes],
        } satisfies PersistedLiveSessionState,
        null,
        2
      )}\n`,
      { encoding: 'utf8', mkdir: true }
    );
    safeFsyncFile(this.#storePath);
  }
}

function scopeKey(linkId: string, resourceRef: string): string {
  return `${linkId}\u0000${resourceRef}`;
}
