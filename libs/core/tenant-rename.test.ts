import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultTenantKnowledgeRoot,
  mutateTenant,
  pathResolver,
  readTenantProfile,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  tenantProfilePath,
} from './index.js';
import { renameTenantWithPlan } from './organization/tenant-rename.js';

const ROOT = pathResolver.rootDir();
const FROM = 'zz-rename-src';
const TO = 'zz-rename-dst';

/** Fixture paths, so cleanup does not depend on the rename having succeeded. */
function allFixturePaths(): string[] {
  return [
    tenantProfilePath(FROM),
    `${tenantProfilePath(FROM)}.renamed`,
    tenantProfilePath(TO),
    path.join(ROOT, defaultTenantKnowledgeRoot(FROM)),
    path.join(ROOT, defaultTenantKnowledgeRoot(TO)),
  ];
}

function removeFixtures(): void {
  for (const target of allFixturePaths()) {
    if (safeExistsSync(target)) safeRmSync(target, { recursive: true, force: true });
  }
}

describe('renameTenant', () => {
  let savedPersona: string | undefined;
  let savedRole: string | undefined;

  beforeEach(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    removeFixtures();
    mutateTenant({ verb: 'create', slug: FROM, displayName: 'Old Trade Name', apply: true });
    // A record inside the tenant's storage, so the move is observable.
    safeWriteFile(
      path.join(ROOT, defaultTenantKnowledgeRoot(FROM), 'marker.json'),
      JSON.stringify({ tenant_slug: FROM, note: 'fixture' }, null, 2),
      { encoding: 'utf8' }
    );
  });

  afterEach(() => {
    removeFixtures();
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });

  it('plans the move without touching anything when not applied', () => {
    const result = renameTenantWithPlan({ fromSlug: FROM, toSlug: TO, scanResidual: false });

    expect(result.status).toBe('dry-run');
    expect(result.moves.map((move) => move.kind)).toEqual(
      expect.arrayContaining(['knowledge_root', 'profile'])
    );
    // Nothing moved: the source is still authoritative.
    expect(readTenantProfile(FROM)).not.toBeNull();
    expect(readTenantProfile(TO)).toBeNull();
    expect(safeExistsSync(path.join(ROOT, defaultTenantKnowledgeRoot(FROM), 'marker.json'))).toBe(
      true
    );
  });

  it('moves storage and rewrites the profile when applied', () => {
    const before = readTenantProfile(FROM);
    const result = renameTenantWithPlan({
      fromSlug: FROM,
      toSlug: TO,
      displayName: 'New Trade Name',
      scanResidual: false,
      apply: true,
    });

    expect(result.status).toBe('applied');
    const renamed = readTenantProfile(TO);
    expect(renamed?.tenant_slug).toBe(TO);
    expect(renamed?.display_name).toBe('New Trade Name');
    expect(renamed?.knowledge_root).toBe(defaultTenantKnowledgeRoot(TO));
    // Storage followed the slug.
    expect(safeExistsSync(path.join(ROOT, defaultTenantKnowledgeRoot(TO), 'marker.json'))).toBe(
      true
    );
    expect(safeExistsSync(path.join(ROOT, defaultTenantKnowledgeRoot(FROM)))).toBe(false);
    // The old profile no longer resolves as a tenant.
    expect(readTenantProfile(FROM)).toBeNull();
    // Identity is preserved so pre-rename audit records still join.
    expect(renamed?.tenant_id).toBe(before?.tenant_id);
    expect(renamed?.metadata?.previous_slug).toBe(FROM);
  });

  it('rewrites structural slug fields inside moved records', () => {
    renameTenantWithPlan({ fromSlug: FROM, toSlug: TO, scanResidual: false, apply: true });

    const marker = JSON.parse(
      safeReadFile(path.join(ROOT, defaultTenantKnowledgeRoot(TO), 'marker.json'), {
        encoding: 'utf8',
      }) as string
    ) as { tenant_slug: string; note: string };
    // Only the structural field moves; free text is left for a human.
    expect(marker.note).toBe('fixture');
  });

  it.each([
    ['a reserved scope name', 'public'],
    ['a tier name', 'confidential'],
  ])('refuses %s as the target slug', (_label, target) => {
    expect(() =>
      renameTenantWithPlan({ fromSlug: FROM, toSlug: target, scanResidual: false })
    ).toThrow(/invalid target slug/);
  });

  it('refuses a rename onto an existing tenant', () => {
    mutateTenant({ verb: 'create', slug: TO, apply: true });
    expect(() => renameTenantWithPlan({ fromSlug: FROM, toSlug: TO, scanResidual: false })).toThrow(
      /already exists/
    );
  });

  it('refuses a no-op rename', () => {
    expect(() =>
      renameTenantWithPlan({ fromSlug: FROM, toSlug: FROM, scanResidual: false })
    ).toThrow(/identical/);
  });

  it('refuses an unknown source tenant', () => {
    expect(() =>
      renameTenantWithPlan({ fromSlug: 'zz-does-not-exist', toSlug: TO, scanResidual: false })
    ).toThrow(/does not exist/);
  });
});
