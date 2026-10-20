/** Explicit targets signed by the accountable human; no wildcard matching. */
export type ExternalOperationGrant =
  | { operation_id: 'vcs:pr_create'; repository: string }
  | { operation_id: 'browser:goto' | 'browser:open_tab'; origin: string };

export function parseExternalOperationGrant(raw: unknown): ExternalOperationGrant | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const repository = value.operation_id === 'vcs:pr_create';
  if (
    !repository &&
    value.operation_id !== 'browser:goto' &&
    value.operation_id !== 'browser:open_tab'
  )
    return undefined;
  const field = repository ? 'repository' : 'origin';
  if (Object.keys(value).sort().join(',') !== ['operation_id', field].sort().join(','))
    return undefined;
  const target = value[field];
  if (typeof target !== 'string' || target.includes('*') || target !== target.trim())
    return undefined;
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return undefined;
    if (
      repository
        ? !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname) ||
          `${url.origin}${url.pathname}` !== target
        : url.origin !== target
    )
      return undefined;
    return repository
      ? { operation_id: 'vcs:pr_create', repository: target }
      : { operation_id: value.operation_id as 'browser:goto' | 'browser:open_tab', origin: target };
  } catch {
    return undefined;
  }
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
