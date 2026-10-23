/** Explicit targets signed by the accountable human; no wildcard matching. */
export type ExternalOperationGrant =
  | { operation_id: 'vcs:pr_create'; repository: string }
  | { operation_id: 'vcs:pr_merge' | 'vcs:push'; repository: string; branch: string }
  | { operation_id: 'browser:goto' | 'browser:open_tab'; origin: string };

/**
 * Declarative delegation registry: one entry per operation that may consult
 * an exact charter grant. Adding a same-shaped operation is one line; a new
 * target shape adds one extractor. Boundaries, the grant parser, the runtime
 * resolver and the attach whitelist all read this table — a new delegable
 * operation needs no further wiring.
 */
export interface DelegationTargetSpec {
  /** Canonical grant fields besides `operation_id` (sorted order in grants). */
  readonly fields: readonly string[];
  /** Normalize an effect into the raw grant object to match, or undefined. */
  readonly buildTarget: (effect: Record<string, unknown>) => unknown;
  /** Reputational class stamped on the delegated charter action. */
  readonly reputational_class: 'A' | 'B';
}

export function normalizeRepositoryTarget(rawUrl: string): string | undefined {
  try {
    const https = rawUrl.startsWith('git@')
      ? `https://${rawUrl.slice(4).replace(/:/, '/')}`
      : rawUrl.startsWith('ssh://')
        ? rawUrl.replace(/^ssh:\/\/(?:git@)?/, 'https://')
        : rawUrl;
    const url = new URL(https);
    const pathname = url.pathname.replace(/\.git$/, '').replace(/\/$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return undefined;
  }
}

function normalizeBranch(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const branch = raw.trim().replace(/^refs\/heads\//, '');
  if (!branch || branch.includes('*') || /[\s^~:?[\]\\]/.test(branch)) return undefined;
  return branch;
}

export const EXTERNAL_OPERATION_DELEGATION: Record<string, DelegationTargetSpec> = {
  'vcs:pr_create': {
    fields: ['repository'],
    buildTarget: (effect) => {
      if (effect.body_source_tier !== 'public' && effect.body_source_tier !== 'inline')
        return undefined;
      const repository = effect.repository as
        { url?: unknown; host?: unknown; slug?: unknown } | undefined;
      if (typeof repository?.url !== 'string') return undefined;
      try {
        const url = new URL(repository.url);
        if (
          url.host !== repository.host ||
          url.pathname.replace(/^\//, '').replace(/\/$/, '') !== repository.slug
        )
          return undefined;
        return {
          operation_id: 'vcs:pr_create',
          repository: `${url.origin}${url.pathname.replace(/\/$/, '')}`,
        };
      } catch {
        return undefined;
      }
    },
    reputational_class: 'B',
  },
  'vcs:pr_merge': {
    fields: ['repository', 'branch'],
    buildTarget: (effect) => {
      const repository = effect.repository as
        { url?: unknown; host?: unknown; slug?: unknown } | undefined;
      if (typeof repository?.url !== 'string' || typeof effect.baseRefName !== 'string')
        return undefined;
      try {
        const url = new URL(repository.url);
        if (
          url.host !== repository.host ||
          url.pathname.replace(/^\//, '').replace(/\/$/, '') !== repository.slug
        )
          return undefined;
        return {
          operation_id: 'vcs:pr_merge',
          repository: `${url.origin}${url.pathname.replace(/\/$/, '')}`,
          branch: effect.baseRefName,
        };
      } catch {
        return undefined;
      }
    },
    reputational_class: 'A',
  },
  'vcs:push': {
    fields: ['repository', 'branch'],
    buildTarget: (effect) => {
      if (typeof effect.url !== 'string' || typeof effect.destination !== 'string')
        return undefined;
      const repository = normalizeRepositoryTarget(effect.url);
      const branch = normalizeBranch(effect.destination);
      if (!repository || !branch) return undefined;
      return { operation_id: 'vcs:push', repository, branch };
    },
    reputational_class: 'A',
  },
  'browser:goto': {
    fields: ['origin'],
    buildTarget: (effect) => buildBrowserNavigationTarget('browser:goto', effect),
    reputational_class: 'B',
  },
  'browser:open_tab': {
    fields: ['origin'],
    buildTarget: (effect) => buildBrowserNavigationTarget('browser:open_tab', effect),
    reputational_class: 'B',
  },
};

function buildBrowserNavigationTarget(
  operationId: 'browser:goto' | 'browser:open_tab',
  effect: Record<string, unknown>
): unknown {
  if (effect.navigation_confinement !== 'isolated-public-read-v1') return undefined;
  const params = effect.params as { url?: unknown } | undefined;
  if (typeof params?.url !== 'string') return undefined;
  try {
    const url = new URL(params.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return undefined;
    return { operation_id: operationId, origin: url.origin };
  } catch {
    return undefined;
  }
}

/** True when the operation may consult an exact charter grant. */
export function isDelegableExternalOperation(operationId: string): boolean {
  return operationId in EXTERNAL_OPERATION_DELEGATION;
}

/** Effect → raw grant target for the resolver (undefined = not delegable here). */
export function buildExternalOperationTarget(
  operationId: string,
  effect: Record<string, unknown>
): unknown {
  return EXTERNAL_OPERATION_DELEGATION[operationId]?.buildTarget(effect);
}

function normalizeRepositoryUrl(target: string): string | undefined {
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return undefined;
    const pathname = url.pathname.replace(/\.git$/, '').replace(/\/$/, '');
    if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pathname)) return undefined;
    return `${url.origin}${pathname}`;
  } catch {
    return undefined;
  }
}

function normalizeOrigin(target: string): string | undefined {
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return undefined;
    return url.origin === target ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function parseExternalOperationGrant(raw: unknown): ExternalOperationGrant | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const op = value.operation_id;
  if (typeof op !== 'string') return undefined;
  const spec = EXTERNAL_OPERATION_DELEGATION[op];
  if (!spec) return undefined;
  if (Object.keys(value).sort().join(',') !== ['operation_id', ...spec.fields].sort().join(','))
    return undefined;
  for (const field of spec.fields) {
    const v = value[field];
    if (typeof v !== 'string' || v.includes('*') || v !== v.trim()) return undefined;
  }
  const normalized = spec.fields.includes('branch')
    ? {
        repository: normalizeRepositoryUrl(value.repository as string),
        branch: normalizeBranch(value.branch),
      }
    : spec.fields.includes('repository')
      ? { repository: normalizeRepositoryUrl(value.repository as string) }
      : { origin: normalizeOrigin(value.origin as string) };
  if (Object.values(normalized).some((v) => !v)) return undefined;
  return { operation_id: op, ...normalized } as ExternalOperationGrant;
}

export function parseExternalOperationGrants(raw: unknown): ExternalOperationGrant[] | undefined {
  if (!Array.isArray(raw) || raw.length > 32) return undefined;
  const result = raw.map(parseExternalOperationGrant);
  if (result.some((value) => !value)) return undefined;
  const grants = result as ExternalOperationGrant[];
  if (new Set(grants.map((value) => JSON.stringify(value))).size !== grants.length)
    return undefined;
  return grants;
}

export function externalOperationGrantMatches(
  left: ExternalOperationGrant,
  right: ExternalOperationGrant
): boolean {
  const a = parseExternalOperationGrant(left);
  const b = parseExternalOperationGrant(right);
  return Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
}
