import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeWriteFile } from '@agent/core/secure-io';
import { allowedPadTiers, PadRecordStore, resolvePadStorage } from './storage.js';

describe('personal pads scoped storage', () => {
  it('only narrows a server-bound tier toward less sensitive tiers', () => {
    expect(allowedPadTiers('personal')).toEqual(['personal', 'confidential', 'public']);
    expect(allowedPadTiers('confidential')).toEqual(['confidential', 'public']);
    expect(allowedPadTiers('public')).toEqual(['public']);
  });

  it('rejects an unknown explicitly selected storage policy', () => {
    expect(() =>
      resolvePadStorage(
        { tier: 'personal', tenant_slug: 'tenant-a' },
        'human:alice',
        'memory-capture',
        'pad.unknown.v9',
        pathResolver.sharedTmp('personal-pads-storage-test')
      )
    ).toThrow('storage policy is not registered');
  });

  it('never allows a non-owner policy to back personal records', () => {
    expect(() =>
      resolvePadStorage(
        { tier: 'personal', tenant_slug: 'tenant-a' },
        'human:alice',
        'memory-capture',
        'pad.public.v1',
        pathResolver.sharedTmp('personal-pads-storage-test')
      )
    ).toThrow('storage policy does not match scope tier');
  });

  it('keeps tenant and owner partitions separate', () => {
    const personal = resolvePadStorage(
      { tier: 'personal', tenant_slug: 'tenant-a' },
      'human:alice',
      'memory-capture',
      undefined,
      pathResolver.sharedTmp('personal-pads-storage-test')
    );
    const otherOwner = resolvePadStorage(
      { tier: 'personal', tenant_slug: 'tenant-a' },
      'human:bob',
      'memory-capture',
      undefined,
      pathResolver.sharedTmp('personal-pads-storage-test')
    );
    const otherTenant = resolvePadStorage(
      { tier: 'personal', tenant_slug: 'tenant-b' },
      'human:alice',
      'memory-capture',
      undefined,
      pathResolver.sharedTmp('personal-pads-storage-test')
    );
    expect(personal.records).not.toBe(otherOwner.records);
    expect(personal.records).not.toBe(otherTenant.records);
    const projectStorage = resolvePadStorage(
      {
        tier: 'confidential',
        tenant_slug: 'tenant-a',
        organization_id: 'org-a',
        project_id: 'project-a',
      },
      'human:alice',
      'meeting-notepad',
      undefined,
      pathResolver.sharedTmp('personal-pads-storage-test')
    );
    expect(projectStorage.records).toContain('/organization/org-a/project/project-a/');
  });

  it('persists records and rebuilds the index from payloads', () => {
    const root = pathResolver.sharedTmp(`personal-pads-storage-${Date.now()}`);
    const scope = {
      scope_kind: 'tenant' as const,
      tier: 'confidential' as const,
      tenant_slug: 'tenant-a',
    };
    const store = new PadRecordStore(scope, 'human:alice', 'meeting-notepad', undefined, root);
    const record = store.save({
      title: '決定',
      body: '議事録本文',
      adapter_id: 'meeting-notepad.v1',
      payload: { attendees: 'Alice', decisions: 'リリース日', body: '' },
      artifacts: [
        {
          field_id: 'attachment',
          name: 'note.txt',
          mime: 'text/plain',
          data_base64: Buffer.from('artifact body').toString('base64'),
        },
      ],
      now: '2026-09-14T00:00:00.000Z',
    });
    expect(store.get(record.record_id)?.body).toBe('議事録本文');
    expect(store.get(record.record_id)?.payload.attendees).toBe('Alice');
    expect(store.get(record.record_id)?.adapter_id).toBe('meeting-notepad.v1');
    expect(record.handoff_ref).toMatch(/^active\/shared\//u);
    expect(record.artifact_refs).toHaveLength(1);
    expect(
      store.readArtifact(record.record_id, record.artifact_refs[0]!.artifact_id)
    ).toMatchObject({
      ref: { name: 'note.txt', mime: 'text/plain' },
      data_base64: Buffer.from('artifact body').toString('base64'),
    });
    expect(store.list().records).toHaveLength(1);
    safeWriteFile(
      path.join(store.storage.payloads, 'orphan.json'),
      JSON.stringify({ ...record, record_id: 'orphan' }),
      { mkdir: true, encoding: 'utf8' }
    );
    expect(store.rebuildIndex()).toBe(1);
    expect(store.list().records[0]?.record_id).toBe(record.record_id);
    const longBody = 'x'.repeat(60_000);
    const longRecord = store.save({ body: longBody, payload: { body: longBody } });
    expect(longRecord.payload.body).toHaveLength(longBody.length);
    expect(longRecord.content_sha256).toBe(createHash('sha256').update(longBody).digest('hex'));
    const repeated = store.save({ title: '決定', body: '別本文', idempotency_key: 'capture-1' });
    const repeatedAgain = store.save({
      title: '決定',
      body: '別本文',
      idempotency_key: 'capture-1',
    });
    expect(repeatedAgain.record_id).toBe(repeated.record_id);
  });

  it('rejects a missing tenant for non-public data', () => {
    expect(() => resolvePadStorage({ tier: 'personal' }, 'human:alice', 'memory-capture')).toThrow(
      'tenant scope is required'
    );
  });

  it('rejects a storage root outside the repository', () => {
    expect(() =>
      resolvePadStorage({ tier: 'public' }, 'human:alice', 'memory-capture', undefined, '/tmp/pads')
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('does not allow a knowledge tier to become the pad storage root', () => {
    expect(() =>
      resolvePadStorage(
        { tier: 'public' },
        'human:alice',
        'memory-capture',
        undefined,
        pathResolver.knowledge('public')
      )
    ).toThrow('must remain under active/shared');
  });

  it('keeps handoff references repository-relative', () => {
    const store = new PadRecordStore(
      { scope_kind: 'system', tier: 'public' },
      'human:alice',
      'memory-capture',
      undefined,
      pathResolver.sharedTmp(`personal-pads-handoff-${Date.now()}`)
    );
    const record = store.save({
      body: 'body',
      handoff_ref: pathResolver.sharedTmp('source/handoff.json'),
    });
    expect(record.handoff_ref).toMatch(/^active\/shared\/tmp\//u);
  });

  it('does not expose records across typed project context', () => {
    const root = pathResolver.sharedTmp(`personal-pads-context-${Date.now()}`);
    const projectA = {
      scope_kind: 'project' as const,
      tier: 'confidential' as const,
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      project_id: 'project-a',
    };
    const projectB = { ...projectA, project_id: 'project-b' };
    const owner = 'human:alice';
    const first = new PadRecordStore(projectA, owner, 'memory-capture', undefined, root).save({
      body: 'project A',
    });
    expect(
      new PadRecordStore(projectB, owner, 'memory-capture', undefined, root).get(first.record_id)
    ).toBeUndefined();
    expect(
      new PadRecordStore(projectB, owner, 'memory-capture', undefined, root).list().records
    ).toEqual([]);
  });

  it('serializes repeated saves without losing index entries', async () => {
    const root = pathResolver.sharedTmp(`personal-pads-concurrency-${Date.now()}`);
    const scope = {
      scope_kind: 'tenant' as const,
      tier: 'confidential' as const,
      tenant_slug: 'tenant-a',
    };
    const store = new PadRecordStore(scope, 'human:alice', 'memory-capture', undefined, root);
    const records = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        Promise.resolve().then(() => store.save({ body: `body-${index}` }))
      )
    );
    expect(new Set(records.map((record) => record.record_id)).size).toBe(8);
    expect(store.list({ limit: 100 }).records).toHaveLength(8);

    const duplicates = await Promise.all(
      Array.from({ length: 6 }, () =>
        Promise.resolve().then(() =>
          store.save({ body: 'ignored', idempotency_key: 'same-request' })
        )
      )
    );
    expect(new Set(duplicates.map((record) => record.record_id)).size).toBe(1);
    expect(store.list({ limit: 100 }).records).toHaveLength(9);
  });
});
