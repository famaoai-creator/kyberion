/** Host binding for PR store IO. It confers no execution or decision authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CharterScope } from './accountability-charter.js';
import { isValidTenantSlug } from '../foundation/scope.js';

export const PR_PUBLICATION_STORE_ROLE = 'pr_publication_store';
export type VcsPublicationOperation = 'vcs:pr_create' | 'vcs:push' | 'vcs:pr_merge';
const runtime = new AsyncLocalStorage<{
  scope: CharterScope;
  invocationId: string;
  operationId: VcsPublicationOperation;
}>();
const resources = new AsyncLocalStorage<{ read: string[]; write: string[] }>();

export function withPrPublicationRuntime<T>(
  scope: CharterScope,
  invocationId: string,
  action: () => T,
  operationId: VcsPublicationOperation = 'vcs:pr_create'
): T {
  if (!/^[a-f0-9]{64}$/.test(invocationId))
    throw new Error('[PR_PUBLICATION_SCOPE] Stable invocation hash required');
  if (
    scope.kind !== 'person' &&
    (scope.kind !== 'organization' || !isValidTenantSlug(scope.tenant_slug))
  )
    throw new Error('[PR_PUBLICATION_SCOPE] Valid publication scope required');
  if (!['vcs:pr_create', 'vcs:push', 'vcs:pr_merge'].includes(operationId))
    throw new Error('[PR_PUBLICATION_SCOPE] Typed VCS mutation required');
  return runtime.run({ scope: structuredClone(scope), invocationId, operationId }, action);
}

export function currentVcsPublicationOperation(): VcsPublicationOperation | undefined {
  return runtime.getStore()?.operationId;
}

export function currentPrPublicationScope(): CharterScope | undefined {
  const scope = runtime.getStore()?.scope;
  return scope ? structuredClone(scope) : undefined;
}

export function withPrPublicationStoreAccess<T>(
  kind: 'charter-read' | 'charter-ledger-write' | 'review-write' | 'reservation-write',
  read: string[],
  write: string[],
  action: () => T
): T {
  const binding = runtime.getStore();
  if (!binding) throw new Error('[PR_PUBLICATION_SCOPE] Trusted publication host required');
  const tenant = binding.scope.kind === 'organization' ? binding.scope.tenant_slug : undefined;
  const charter = tenant
    ? `knowledge/confidential/${tenant}/charters`
    : 'knowledge/personal/charters';
  const floor = tenant ? `confidential/${tenant}` : 'personal/shared';
  const artifact = `active/shared/artifacts/${floor}`;
  const valid = (value: string) =>
    value.length > 0 &&
    !value.includes('\\') &&
    !value.split('/').includes('..') &&
    !value.startsWith('/');
  const matches = (value: string, writing: boolean): boolean => {
    if (!valid(value)) return false;
    if (kind === 'charter-read')
      return (
        !writing &&
        (value === charter ||
          (value.startsWith(charter + '/') &&
            /^[a-z0-9-]+(?:\.ledger\.jsonl|\.json)$/.test(value.slice(charter.length + 1))))
      );
    if (kind === 'charter-ledger-write')
      return (
        Boolean(tenant) &&
        value.startsWith(charter + '/') &&
        /^[a-z0-9-]+\.ledger\.jsonl$/.test(value.slice(charter.length + 1))
      );
    if (kind === 'review-write')
      return (
        value === `${artifact}/artifacts-index.jsonl` ||
        (value.startsWith(
          `${artifact}/evidence/${binding.operationId === 'vcs:pr_create' ? 'pr-publication' : 'vcs-publication'}/${binding.invocationId}/`
        ) &&
          /^[a-f0-9]{64}\.json$/.test(value.split('/').at(-1)!))
      );
    return new RegExp(
      `^active/shared/(?:runtime/external-operations/${floor}|tmp/${floor}/vitest-external-operations/[\\w-]+/[\\w-]+)/[a-f0-9]{64}\\.json$`
    ).test(value);
  };
  if (!read.every((file) => matches(file, false)) || !write.every((file) => matches(file, true)))
    throw new Error('[PR_PUBLICATION_SCOPE] Resource is outside publication store');
  return resources.run({ read: [...read], write: [...write] }, action);
}

export function prPublicationResourceAllowed(
  target: string,
  operation: 'read' | 'write' | 'append' | 'mkdir' | 'metadata'
): boolean {
  if (!runtime.getStore()) return false;
  const scope = resources.getStore();
  if (!scope) return false;
  // Shared schema/catalog validation retains the worker's existing product
  // read permission while the exact private IO capability is installed.
  if (
    (operation === 'read' || operation === 'metadata') &&
    (target === 'knowledge/product' || target.startsWith('knowledge/product/'))
  )
    return true;
  if (operation === 'write' || operation === 'append') return scope.write.includes(target);
  if (operation === 'read') return scope.read.includes(target) || scope.write.includes(target);
  return [...scope.read, ...scope.write].some(
    (file) => file === target || target === '' || file.startsWith(target + '/')
  );
}
