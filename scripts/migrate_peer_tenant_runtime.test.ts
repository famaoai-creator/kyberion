import { afterEach, describe, expect, it } from 'vitest';

import { readTextFile } from '@agent/core/foundation';
import { pathResolver, safeExistsSync, safeRmSync, safeWriteFile } from '@agent/core';
import {
  applyPeerTenantMigrationPlan,
  buildPeerTenantMigrationPlan,
  parsePeerTenantMigrationPlan,
  runPeerTenantMigration,
  type PeerTenantMigrationRoot,
} from './migrate_peer_tenant_runtime.js';

const ROOT = pathResolver.sharedTmp('peer-tenant-migration-test');
const LEGACY_ROOT = `${ROOT}/active/shared/runtime/peer-messaging`;
const CONVERSATION_ROOT = `${ROOT}/active/shared/runtime/peer-conversations`;
const MESH_ROOT = `${ROOT}/active/shared/runtime/mesh-hub`;
const MIGRATION_ROOT = `${ROOT}/active/shared/runtime/migrations/peer-tenant`;

const legacyRoots: PeerTenantMigrationRoot[] = [
  { kind: 'peer-messaging', root: LEGACY_ROOT },
  { kind: 'peer-conversations', root: CONVERSATION_ROOT },
  { kind: 'mesh-hub-runtime', root: MESH_ROOT },
];

afterEach(() => {
  safeRmSync(ROOT, { recursive: true, force: true });
});

describe('peer tenant runtime migration', () => {
  it('rejects malformed or unsafe persisted plans before apply', () => {
    const unsafePlan = {
      format: 'kyberion-peer-tenant-migration-v1',
      migration_id: 'migration-test',
      generated_at: '2026-09-01T00:00:00.000Z',
      apply_requested: true,
      migration_root: MIGRATION_ROOT,
      sources: [
        {
          kind: 'peer-messaging',
          source: `${LEGACY_ROOT}/peer-a/inbox.jsonl`,
          source_quarantine: `${MIGRATION_ROOT}/quarantine/inbox.legacy`,
          source_sha256: 'hash',
          action: 'migrate',
          unknown_record_count: 0,
          records: 1,
          destinations: [
            {
              tenant_id: 'tenant-acme',
              destination: `${LEGACY_ROOT}/tenants/tenant-acme/inbox.jsonl`,
              record_count: 1,
              disposition: 'move',
            },
          ],
          state: 'planned',
        },
      ],
      status: 'planned',
    } as Record<string, unknown>;
    expect(parsePeerTenantMigrationPlan(unsafePlan)).not.toBeNull();

    const malformedPlan = {
      format: 'kyberion-peer-tenant-migration-v1',
      migration_id: 'migration-test',
      generated_at: '2026-09-01T00:00:00.000Z',
      apply_requested: true,
      migration_root: MIGRATION_ROOT,
      sources: [],
      status: 'planned',
    } as Record<string, unknown>;
    Object.defineProperty(malformedPlan, '__proto__', {
      value: { source: '/tmp/unsafe' },
      enumerable: true,
    });
    expect(parsePeerTenantMigrationPlan(malformedPlan)).toBeNull();
  });

  it('rejects an external plan path before reading it', () => {
    expect(() =>
      runPeerTenantMigration({ planPath: '/tmp/external-peer-migration-plan.json' })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('splits explicit tenant records and quarantines legacy sources', () => {
    safeWriteFile(
      `${LEGACY_ROOT}/peer-a/inbox.jsonl`,
      [
        JSON.stringify({ envelope: { tenant_id: 'tenant-acme', message_id: 'a' } }),
        JSON.stringify({ envelope: { tenant_id: 'tenant-bravo', message_id: 'b' } }),
        JSON.stringify({ envelope: { message_id: 'unknown' } }),
      ].join('\n') + '\n'
    );
    safeWriteFile(
      `${CONVERSATION_ROOT}/peer-a/sessions/PCS-1.json`,
      JSON.stringify({ tenant_id: 'tenant-acme', session_id: 'PCS-1' })
    );
    safeWriteFile(
      `${MESH_ROOT}/mesh-a/deliveries.jsonl`,
      JSON.stringify({ tenant_scope: { tenant_id: 'tenant-acme' }, delivery_id: 'd1' }) + '\n'
    );

    const plan = buildPeerTenantMigrationPlan({
      migrationId: 'migration-test',
      migrationRoot: MIGRATION_ROOT,
      legacyRoots,
    });
    expect(plan.status).toBe('planned');
    expect(plan.sources).toHaveLength(3);
    expect(plan.sources[0].destinations.map((entry) => entry.tenant_id)).toEqual([
      'tenant-acme',
      'tenant-bravo',
    ]);
    expect(plan.sources[0].unknown_record_count).toBe(1);

    const applied = applyPeerTenantMigrationPlan(plan);
    expect(applied.status).toBe('completed');
    expect(safeExistsSync(`${LEGACY_ROOT}/tenants/tenant-acme/peers/peer-a/inbox.jsonl`)).toBe(
      true
    );
    expect(safeExistsSync(`${LEGACY_ROOT}/tenants/tenant-bravo/peers/peer-a/inbox.jsonl`)).toBe(
      true
    );
    expect(safeExistsSync(`${LEGACY_ROOT}/peer-a/inbox.jsonl`)).toBe(false);
    expect(safeExistsSync(`${MESH_ROOT}/mesh-a/tenants/tenant-acme/deliveries.jsonl`)).toBe(true);
    expect(safeExistsSync(`${MIGRATION_ROOT}/quarantine/migration-test/peer-messaging`)).toBe(true);
  });

  it('keeps records without a trustworthy tenant quarantined unless explicitly overridden', () => {
    safeWriteFile(
      `${LEGACY_ROOT}/peer-a/outbox.jsonl`,
      [
        JSON.stringify({ message_id: 'legacy-without-tenant' }),
        '{"__proto__":{"tenant_id":"tenant-acme"},"message_id":"unsafe"}',
      ].join('\n') + '\n'
    );
    const plan = buildPeerTenantMigrationPlan({
      migrationId: 'migration-unknown',
      migrationRoot: MIGRATION_ROOT,
      legacyRoots: [legacyRoots[0]],
    });
    expect(plan.sources[0].action).toBe('quarantine');
    expect(plan.sources[0].unknown_record_count).toBe(2);
    applyPeerTenantMigrationPlan(plan);
    expect(safeExistsSync(`${LEGACY_ROOT}/peer-a/outbox.jsonl`)).toBe(false);
    expect(safeExistsSync(`${LEGACY_ROOT}/tenants`)).toBe(false);

    safeWriteFile(
      `${LEGACY_ROOT}/peer-a/outbox.jsonl`,
      JSON.stringify({ message_id: 'legacy-explicit-tenant' }) + '\n'
    );
    const overridden = buildPeerTenantMigrationPlan({
      migrationId: 'migration-override',
      migrationRoot: MIGRATION_ROOT,
      tenantIdOverride: 'tenant-acme',
      legacyRoots: [legacyRoots[0]],
    });
    expect(overridden.sources[0].destinations[0].tenant_id).toBe('tenant-acme');
    applyPeerTenantMigrationPlan(overridden);
    expect(safeExistsSync(`${LEGACY_ROOT}/tenants/tenant-acme/peers/peer-a/outbox.jsonl`)).toBe(
      true
    );
  });

  it('routes the migration plan through the shared script printer', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/migrate_peer_tenant_runtime.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) =>');
    expect(source).toContain('isRecord, nowIso, parseSafeJsonInput, readTextFile');
  });
});
