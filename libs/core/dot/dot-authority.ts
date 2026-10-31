import { findActiveCharter } from '../governance/accountability-charter-registry.js';
import type { DotCharter } from './dot-charter.js';

/** A declared ref is an authority constraint, never an optional hint. */
export function assertDotAccountabilityCharter(
  dot: DotCharter,
  deps: { rootDir?: string; now?: () => Date } = {}
): void {
  if (dot.authority.authority_role === 'dot_result_writer')
    throw new Error('dot_result_writer is an internal store role, never a DOT execution role');
  const ref = dot.authority.accountability_charter_ref;
  if (ref === undefined) return;
  if (!ref || !dot.scope.tenant_slug)
    throw new Error('accountability charter ref requires tenant scope');
  const charter = findActiveCharter(
    { kind: 'organization', tenant_slug: dot.scope.tenant_slug },
    deps.now?.() ?? new Date(),
    deps
  );
  if (
    !charter ||
    charter.charter_id !== ref ||
    charter.scope.kind !== 'organization' ||
    charter.scope.tenant_slug !== dot.scope.tenant_slug ||
    !/^[0-9a-f]{64}$/.test(charter.accountable.statement_sha256)
  ) {
    throw new Error(
      `accountability charter '${ref}' is not the current accepted charter for this tenant`
    );
  }
}
