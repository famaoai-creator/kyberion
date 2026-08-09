import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeFsyncFile, safeReadFile, safeWriteFile } from './secure-io.js';
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

function required(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new ShareGrantLiveSessionValidationError(`${label} is required`);
  if (normalized.length > 512) {
    throw new ShareGrantLiveSessionValidationError(`${label} exceeds the 512-character limit`);
  }
  return normalized;
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
      connectedAt: required(input.connectedAt, 'connectedAt'),
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
    required(input.revokedAt, 'revokedAt');
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
      parsed = JSON.parse(String(safeReadFile(this.#storePath, { encoding: 'utf8' })));
    } catch (error) {
      throw new ShareGrantLiveSessionValidationError(
        `live-session state could not be read: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (
      parsed?.version !== 1 ||
      !Array.isArray(parsed.sessions) ||
      !Array.isArray(parsed.revokedScopes)
    ) {
      throw new ShareGrantLiveSessionValidationError('live-session state has an invalid schema');
    }
    this.#sessions.clear();
    this.#revokedScopes.clear();
    for (const scope of parsed.revokedScopes) {
      this.#revokedScopes.add(required(scope, 'revokedScope'));
    }
    for (const session of parsed.sessions) {
      const normalized = {
        sessionId: required(session.sessionId, 'sessionId'),
        linkId: required(session.linkId, 'linkId'),
        resourceRef: required(session.resourceRef, 'resourceRef'),
        connectedAt: required(session.connectedAt, 'connectedAt'),
      };
      if (this.#revokedScopes.has(scopeKey(normalized.linkId, normalized.resourceRef))) {
        continue;
      }
      this.#sessions.set(normalized.sessionId, normalized);
    }
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
