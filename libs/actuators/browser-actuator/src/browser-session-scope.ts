import { currentScope } from '@agent/core/scope-context';

export function browserScopeFingerprint(): string {
  const scope = currentScope();
  return `${scope.tier}:${scope.tenant_slug || 'shared'}`;
}

export function assertBrowserSessionOwner(actual: string | undefined, expected: string): void {
  if (!actual || actual !== expected) {
    throw new Error(
      `[BROWSER_SESSION_OWNER_MISMATCH] session is bound to ${actual || 'unknown scope'}; current scope is ${expected}`
    );
  }
}

/** Enforce retained/live profile ownership when reopening a persisted browser session. */
export function assertPersistedBrowserSessionOwner(
  persisted: {
    scope_fingerprint?: string;
    retained?: boolean;
    lease_status?: string;
    user_data_dir?: string;
  } | null,
  expected: string,
  profileExists: boolean
): void {
  if (!persisted) return;
  if (persisted.scope_fingerprint) {
    assertBrowserSessionOwner(persisted.scope_fingerprint, expected);
    return;
  }
  if (persisted.retained && persisted.lease_status === 'active') {
    assertBrowserSessionOwner(undefined, expected);
    return;
  }
  if (profileExists) {
    // Legacy metadata with a live profile has no trustworthy owner.
    assertBrowserSessionOwner(undefined, expected);
  }
}
