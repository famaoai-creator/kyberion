import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeReaddir, safeExistsSync, safeRmSync, safeWriteFile, safeMkdir } from '../secure-io.js';
import {
  loadServiceBindingRecord,
  migrateBindingOwners,
  rollbackBindingOwners,
  saveServiceBindingRecord,
  type ServiceBindingRecord,
} from './service-binding-registry.js';

const BIND_DIR = pathResolver.shared('runtime/service-bindings');
const BACKUP_ROOT = pathResolver.shared('runtime/service-bindings-backup');
const ID = (suffix: string) => `BIND-OWNER-${suffix}`;
const base = (suffix: string): ServiceBindingRecord => ({
  binding_id: ID(suffix),
  service_type: 'chat',
  scope: 'tenant',
  target: 'workspace',
  allowed_actions: ['read'],
  secret_refs: [],
  approval_policy: { read: 'allowed' },
});

describe('service binding owners', () => {
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const backups: string[] = [];
  beforeAll(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
  });
  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (safeExistsSync(BIND_DIR)) {
      for (const f of safeReaddir(BIND_DIR).filter((n) => n.startsWith('BIND-OWNER-'))) {
        safeRmSync(path.join(BIND_DIR, f), { force: true });
      }
    }
    for (const dir of backups) safeRmSync(dir, { recursive: true, force: true });
  });

  it('saving an organization connection makes its owner explicit', () => {
    saveServiceBindingRecord({ ...base('ORG'), tenant_slug: 'acme' });
    expect(loadServiceBindingRecord(ID('ORG'))).toMatchObject({
      owner_kind: 'organization',
      owner_ref: 'acme',
    });
  });

  it('refuses an incoherent owner (a person connection carrying a tenant)', () => {
    expect(() =>
      saveServiceBindingRecord({
        ...base('BAD'),
        tenant_slug: 'acme',
        owner_kind: 'person',
        owner_ref: 'user:alice',
      })
    ).toThrow(/must not carry tenant_slug/);
    expect(loadServiceBindingRecord(ID('BAD'))).toBeNull();
  });

  it('a legacy person connection is left unmarked on save (no member to name)', () => {
    saveServiceBindingRecord(base('LEGACY'));
    expect(loadServiceBindingRecord(ID('LEGACY'))?.owner_kind).toBeUndefined();
  });

  it('migration: dry-run writes nothing; apply backs up first; rollback restores', () => {
    // Legacy organization record written before the owner field existed.
    safeMkdir(BIND_DIR, { recursive: true });
    safeWriteFile(
      path.join(BIND_DIR, `${ID('OLDORG')}.json`),
      JSON.stringify({ ...base('OLDORG'), tenant_slug: 'beta' }, null, 2)
    );
    const mine = (r: ReturnType<typeof migrateBindingOwners>) =>
      Object.fromEntries(
        r.entries
          .filter((e) => e.binding_id.startsWith('BIND-OWNER-'))
          .map((e) => [e.binding_id, e.action])
      );
    const dry = migrateBindingOwners({});
    expect(dry.applied).toBe(false);
    expect(mine(dry)).toMatchObject({
      [ID('OLDORG')]: 'backfill_organization',
      [ID('LEGACY')]: 'needs_decision',
      [ID('ORG')]: 'already_explicit',
    });
    expect(loadServiceBindingRecord(ID('OLDORG'))?.owner_kind).toBeUndefined();

    const applied = migrateBindingOwners({ apply: true, assignPerson: 'user:alice' });
    if (applied.backup_dir) backups.push(applied.backup_dir);
    expect(applied.applied).toBe(true);
    expect(applied.backup_dir && safeExistsSync(applied.backup_dir)).toBe(true);
    expect(mine(applied)[ID('LEGACY')]).toBe('assign_person');
    expect(loadServiceBindingRecord(ID('OLDORG'))).toMatchObject({
      owner_kind: 'organization',
      owner_ref: 'beta',
    });
    expect(loadServiceBindingRecord(ID('LEGACY'))).toMatchObject({
      owner_kind: 'person',
      owner_ref: 'user:alice',
    });

    expect(rollbackBindingOwners(applied.backup_dir!)).toBeGreaterThan(0);
    expect(loadServiceBindingRecord(ID('OLDORG'))?.owner_kind).toBeUndefined();
    expect(loadServiceBindingRecord(ID('LEGACY'))?.owner_kind).toBeUndefined();
    expect(() => rollbackBindingOwners(BIND_DIR)).toThrow(/backup/);
    expect(safeExistsSync(BACKUP_ROOT)).toBe(true);
  });
});
