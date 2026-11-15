import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from '../secure-io.js';
import { physicalScopedPath, partitionedScopedPath } from '../storage/physical-namespace.js';
import { listInboxEntries, markInboxEntry } from '../task/deliverable-inbox.js';
import { readNeedsYouSources } from './needs-you-sources.js';
import { notifyOperatorWithReceiptSync } from './operator-notifications.js';
import { listSurfaceOutboxMessages } from './surface-coordination-store.js';
import type { MemoryScopeEnvelope } from '../knowledge/memory-scope.js';

const cleanup = new Set<string>();
const previousAllowed = process.env.KYBERION_ALLOW_TEST_NOTIFICATIONS;
afterEach(() => {
  withExecutionContext(
    'mission_controller',
    () => {
      for (const file of cleanup) safeRmSync(file, { recursive: true, force: true });
    },
    'sovereign'
  );
  cleanup.clear();
  if (previousAllowed === undefined) delete process.env.KYBERION_ALLOW_TEST_NOTIFICATIONS;
  else process.env.KYBERION_ALLOW_TEST_NOTIFICATIONS = previousAllowed;
});

describe('scoped notification delivery through real storage and viewer readers', () => {
  it.each(['confidential', 'personal'] as const)(
    'does not elevate a surface_runtime caller for a %s receipt',
    (tier) => {
      process.env.KYBERION_ALLOW_TEST_NOTIFICATIONS = '1';
      const id = randomUUID();
      const scope: MemoryScopeEnvelope =
        tier === 'personal'
          ? { tier, owner_nhi: 'user:denied-' + id }
          : { tier, tenant_slug: 'denied-' + id.slice(0, 8) };
      const receiptDirectory = pathResolver.rootResolve(
        partitionedScopedPath('active/shared/runtime/operator-notification-receipts', {
          ...scope,
          nhi_id: scope.owner_nhi,
        })
      );
      cleanup.add(receiptDirectory);
      expect(
        withExecutionContext('surface_runtime', () =>
          notifyOperatorWithReceiptSync(
            'decision_digest',
            {
              title: 'Denied private notification',
              body: 'Private synthetic body',
              correlation_id: id,
            },
            { scope, route: { surface: 'inbox', target: 'quiet-hours' }, deduplicationKey: id }
          )
        )
      ).toMatchObject({ status: 'retryable', reason: 'intent_not_created' });
      withExecutionContext(
        'mission_controller',
        () => {
          expect(safeExistsSync(receiptDirectory)).toBe(false);
          expect(listInboxEntries({ scope, limit: 10 })).toHaveLength(0);
        },
        'sovereign'
      );
    }
  );

  it.each(['confidential', 'personal'] as const)(
    'keeps %s remote outbox and acceptance replay in the source scope',
    (tier) => {
      process.env.KYBERION_ALLOW_TEST_NOTIFICATIONS = '1';
      const id = randomUUID();
      const scope: MemoryScopeEnvelope =
        tier === 'personal'
          ? { tier, owner_nhi: 'user:outbox-' + id }
          : { tier, tenant_slug: 'outbox-' + id.slice(0, 8), organization_id: 'org-a' };
      const eventScope = {
        tier,
        ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
        ...(scope.organization_id ? { organization_id: scope.organization_id } : {}),
        ...(scope.owner_nhi ? { nhi_id: scope.owner_nhi } : {}),
      };
      cleanup.add(
        pathResolver.rootResolve(
          physicalScopedPath('active/shared/coordination/channels/slack', eventScope)
        )
      );
      cleanup.add(
        pathResolver.rootResolve(
          partitionedScopedPath('active/shared/runtime/operator-notification-receipts', eventScope)
        )
      );
      const payload = {
        title: 'Private outbox ' + id,
        body: 'Scoped synthetic body',
        correlation_id: id,
      };
      const options = {
        scope,
        route: { surface: 'slack' as const, target: 'C-SCOPED-TEST' },
        deduplicationKey: id,
      };
      withExecutionContext(
        'mission_controller',
        () => {
          expect(notifyOperatorWithReceiptSync('decision_digest', payload, options)).toMatchObject({
            status: 'accepted',
            reason: 'durable_outbox',
          });
          expect(notifyOperatorWithReceiptSync('decision_digest', payload, options)).toMatchObject({
            status: 'accepted',
            reason: 'durable_replay',
          });
          const rows = listSurfaceOutboxMessages('slack', { scope: eventScope });
          expect(rows.filter((row) => row.text.includes(payload.title))).toHaveLength(1);
          expect(rows.find((row) => row.text.includes(payload.title))?.scope).toMatchObject(
            eventScope
          );
          expect(
            listSurfaceOutboxMessages('slack').some((row) => row.text.includes(payload.title))
          ).toBe(false);
        },
        'sovereign'
      );
    }
  );

  it.each(['confidential', 'personal'] as const)(
    'preserves %s custody through quiet-hours delivery and replay',
    (tier) => {
      process.env.KYBERION_ALLOW_TEST_NOTIFICATIONS = '1';
      const id = randomUUID();
      const tenant = 'notify-' + id.slice(0, 8);
      const owner = 'user:notification-' + id;
      const scope: MemoryScopeEnvelope =
        tier === 'personal'
          ? { tier, owner_nhi: owner }
          : { tier, tenant_slug: tenant, organization_id: 'org-a', project_id: 'project-a' };
      const eventScope = { ...scope, nhi_id: scope.owner_nhi };
      cleanup.add(pathResolver.rootResolve(physicalScopedPath('active/shared/inbox', eventScope)));
      cleanup.add(
        pathResolver.rootResolve(
          partitionedScopedPath('active/shared/runtime/operator-notification-receipts', eventScope)
        )
      );
      const payload = {
        title: 'Private synthetic notification ' + id,
        body: 'Private synthetic body',
        correlation_id: id,
      };
      const options = {
        scope,
        route: { surface: 'inbox' as const, target: 'quiet-hours' },
        deduplicationKey: id,
      };
      const first = withExecutionContext(
        'mission_controller',
        () => notifyOperatorWithReceiptSync('decision_digest', payload, options),
        'sovereign'
      );
      expect(first).toMatchObject({ status: 'accepted', reason: 'local_inbox' });
      expect(
        withExecutionContext(
          'mission_controller',
          () => notifyOperatorWithReceiptSync('decision_digest', payload, options),
          'sovereign'
        )
      ).toMatchObject({ status: 'accepted', reason: 'durable_replay' });
      const entries = withExecutionContext(
        'mission_controller',
        () => listInboxEntries({ scope, limit: 100 }),
        'sovereign'
      );
      expect(entries.filter((entry) => entry.title === payload.title)).toHaveLength(1);
      expect(entries.find((entry) => entry.title === payload.title)).toMatchObject(scope);
      const entry = entries.find((row) => row.title === payload.title)!;
      if (tier === 'personal') {
        expect(
          withExecutionContext(
            'mission_controller',
            () => markInboxEntry(entry.entry_id, 'read'),
            'sovereign'
          )
        ).toBeNull();
        expect(
          withExecutionContext(
            'mission_controller',
            () =>
              markInboxEntry(entry.entry_id, 'read', {
                scope: { ...scope, owner_nhi: 'user:foreign' },
              }),
            'sovereign'
          )
        ).toBeNull();
      }
      expect(
        withExecutionContext(
          'mission_controller',
          () => markInboxEntry(entry.entry_id, 'read', { scope }),
          'sovereign'
        )
      ).toMatchObject({ status: 'read', ...scope });
      const viewer = {
        role: 'readonly' as const,
        tenantSlugs: tier === 'personal' ? [] : [tenant],
        organizationIds: 'all' as const,
        projectIds: 'all' as const,
        tierAccess: ['public', 'confidential', 'personal'],
        personIds: [owner],
        includeUntenanted: true,
      };
      const visible = readNeedsYouSources(viewer).outcomes;
      expect(visible.some((entry) => entry.title === payload.title)).toBe(true);
      for (const foreign of [
        { ...viewer, tenantSlugs: [], personIds: ['user:other'] },
        { ...viewer, tierAccess: ['public'], tenantSlugs: 'all' as const, personIds: [] },
        { ...viewer, organizationIds: ['org-other'], projectIds: ['project-other'] },
      ])
        expect(
          readNeedsYouSources(foreign).outcomes.some((entry) => entry.title === payload.title)
        ).toBe(false);
      const legacy = pathResolver.shared('inbox/entries.jsonl');
      if (safeExistsSync(legacy)) expect(String(safeReadFile(legacy))).not.toContain(payload.title);
    }
  );
});
