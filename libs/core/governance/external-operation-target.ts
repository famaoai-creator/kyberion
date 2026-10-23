/** Explicit targets signed by the accountable human; no wildcard matching. */
export type ExternalOperationGrant =
  | { operation_id: 'vcs:pr_create'; repository: string }
  | { operation_id: 'vcs:pr_merge' | 'vcs:push'; repository: string; branch: string }
  | { operation_id: 'browser:goto' | 'browser:open_tab'; origin: string };

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

function normalizeBranch(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const branch = raw.trim().replace(/^refs\/heads\//, '');
  if (!branch || branch.includes('*') || /[\s^~:?[\]\\]/.test(branch)) return undefined;
  return branch;
}

export function parseExternalOperationGrant(raw: unknown): ExternalOperationGrant | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const op = value.operation_id;
  if (op === 'vcs:pr_create' || op === 'browser:goto' || op === 'browser:open_tab') {
    const field = op === 'vcs:pr_create' ? 'repository' : 'origin';
    if (Object.keys(value).sort().join(',') !== ['operation_id', field].sort().join(','))
      return undefined;
    const target = value[field];
    if (typeof target !== 'string' || target.includes('*') || target !== target.trim())
      return undefined;
    const normalized =
      field === 'repository' ? normalizeRepositoryUrl(target) : normalizeOrigin(target);
    if (!normalized) return undefined;
    return op === 'vcs:pr_create'
      ? { operation_id: 'vcs:pr_create', repository: normalized }
      : { operation_id: op, origin: normalized };
  }
  if (op === 'vcs:pr_merge' || op === 'vcs:push') {
    if (
      Object.keys(value).sort().join(',') !==
      ['operation_id', 'repository', 'branch'].sort().join(',')
    )
      return undefined;
    if (typeof value.repository !== 'string' || value.repository !== value.repository.trim())
      return undefined;
    const repository = normalizeRepositoryUrl(value.repository);
    const branch = normalizeBranch(value.branch);
    if (!repository || !branch) return undefined;
    return { operation_id: op, repository, branch };
  }
  return undefined;
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
