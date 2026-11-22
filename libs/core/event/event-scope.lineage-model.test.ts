import { describe, expect, it } from 'vitest';
import {
  type EventScope,
  type EventScopeInput,
  parseEventScopeFromRecord,
  parseEventScopeInput,
  redactEventScopeForShared,
  resolveEventScopeAgainstAuthority,
  serializeEventScope,
} from './event-scope.js';

const alternate: Required<
  Pick<
    EventScopeInput,
    | 'tier'
    | 'tenant_slug'
    | 'organization_id'
    | 'project_id'
    | 'mission_id'
    | 'task_id'
    | 'session_id'
  >
> = {
  tier: 'personal',
  tenant_slug: 'tenant-b',
  organization_id: 'org-b',
  project_id: 'project-b',
  mission_id: 'MSN-B',
  task_id: 'task-b',
  session_id: 'session-b',
};
const fields = Object.keys(alternate) as (keyof typeof alternate)[];
const decorations = {
  customer_stance: 'customer-b',
  viewer_principal: 'human:fixture',
  nhi_id: 'kyberion://agent/fixture/worker',
};

const authorities = [
  {
    scope_kind: 'session',
    tier: 'confidential',
    tenant_slug: 'tenant-a',
    organization_id: 'org-a',
    project_id: 'project-a',
    mission_id: 'MSN-A',
    task_id: 'task-a',
    session_id: 'session-a',
  },
  { scope_kind: 'project', tier: 'public', project_id: 'project-a' },
] satisfies EventScope[];

function inputs(authority: EventScope) {
  return fields.reduce<{ supplied: EventScopeInput; agrees: boolean }[]>(
    (cases, field) =>
      cases.flatMap(({ supplied, agrees }) => {
        const inherited = authority[field];
        return [
          { supplied, agrees },
          ...(inherited === undefined
            ? []
            : [{ supplied: { ...supplied, [field]: inherited }, agrees }]),
          { supplied: { ...supplied, [field]: alternate[field] }, agrees: false },
        ];
      }),
    [{ supplied: decorations, agrees: true }]
  );
}

describe('event scope lineage finite model', () => {
  it.each([
    { authority: authorities[0]!, total: 2187, accepted: 128 },
    { authority: authorities[1]!, total: 288, accepted: 4 },
  ])(
    'preserves authoritative lineage through the $authority.scope_kind lifecycle',
    ({ authority, total, accepted }) => {
      const cases = inputs(authority);
      expect(cases).toHaveLength(total);
      expect(cases.filter(({ agrees }) => agrees)).toHaveLength(accepted);
      for (const { supplied, agrees } of cases) {
        const input = parseEventScopeInput(supplied);
        const resolve = () => resolveEventScopeAgainstAuthority(authority, input);
        const label = JSON.stringify(supplied);
        if (!agrees) {
          expect(resolve, label).toThrow('[EVENT_SCOPE_LINEAGE_CONFLICT]');
          continue;
        }
        const resolved = resolve();
        expect(resolved, label).toEqual({ ...authority, ...decorations });
        const saved = serializeEventScope(redactEventScopeForShared(resolved));
        expect(parseEventScopeFromRecord({ scope_context: saved }), label).toEqual({
          has_scope: true,
          invalid: false,
          scope: authority,
        });
      }
    }
  );

  it('treats the legacy tenant alias as the same boundary and rejects conflicting aliases', () => {
    const authority = authorities[0]!;
    const tenant = authority.tenant_slug;
    for (const tenant_slug of [undefined, tenant, alternate.tenant_slug]) {
      for (const tenant_id of [undefined, tenant, alternate.tenant_slug]) {
        const resolve = () =>
          resolveEventScopeAgainstAuthority(
            authority,
            parseEventScopeInput({ tenant_slug, tenant_id })
          );
        if ([tenant_slug, tenant_id].includes(alternate.tenant_slug)) {
          expect(resolve).toThrow(/LINEAGE_CONFLICT|conflicts with compatibility tenant_id/);
        } else {
          expect(resolve()).toEqual(authority);
        }
      }
    }
  });
});
