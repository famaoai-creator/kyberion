/**
 * Canonicalize a client-supplied repository-relative read reference before
 * applying scope checks.  Scope must be derived from the exact path that is
 * later handed to pathResolver; accepting dot segments would otherwise let
 * the checked tier/tenant differ from the file actually read.
 */
export function normalizeScopedReadPath(input: string): string | null {
  const raw = String(input || '')
    .trim()
    .replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//u.test(raw)) return null;

  const segments = raw.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
}
