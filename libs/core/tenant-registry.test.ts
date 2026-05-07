import * as path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureDefaultTenantProfile,
  pathResolver,
  tenantProfilePath,
  writeTenantGroupProfile,
} from './index.js';

const ROOT = pathResolver.rootDir();
const TENANT_DIR = path.join(ROOT, 'knowledge/personal/tenants');
const GROUP_DIR = path.join(ROOT, 'knowledge/confidential/tenant-groups');

describe('tenant-registry', () => {
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let savedTenant: string | undefined;
  let savedDefaultProfile: string | null;
  let savedUnitSharedGroup: string | null;

  beforeEach(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    savedTenant = process.env.KYBERION_TENANT;
    const defaultPath = path.join(TENANT_DIR, 'default.json');
    const groupPath = path.join(GROUP_DIR, 'unit-shared.json');
    savedDefaultProfile = fs.existsSync(defaultPath) ? fs.readFileSync(defaultPath, 'utf8') : null;
    savedUnitSharedGroup = fs.existsSync(groupPath) ? fs.readFileSync(groupPath, 'utf8') : null;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    delete process.env.KYBERION_TENANT;
  });

  afterEach(() => {
    const defaultPath = path.join(TENANT_DIR, 'default.json');
    const groupPath = path.join(GROUP_DIR, 'unit-shared.json');
    try {
      if (savedDefaultProfile === null) fs.rmSync(defaultPath, { force: true });
      else fs.writeFileSync(defaultPath, savedDefaultProfile);
    } catch {}
    try {
      if (savedUnitSharedGroup === null) fs.rmSync(groupPath, { force: true });
      else fs.writeFileSync(groupPath, savedUnitSharedGroup);
    } catch {}
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
  });

  it('bootstraps the default tenant profile when missing', () => {
    fs.rmSync(path.join(TENANT_DIR, 'default.json'), { force: true });
    const profile = ensureDefaultTenantProfile();
    expect(profile.tenant_slug).toBe('default');
    expect(fs.existsSync(tenantProfilePath('default'))).toBe(true);
  });

  it('writes a tenant group profile with normalized members and shared prefix', () => {
    const group = writeTenantGroupProfile({
      tenant_group_id: 'unit-shared',
      display_name: 'Unit Shared',
      status: 'active',
      member_tenants: ['acme-corp', 'beta-co', 'acme-corp'],
      shared_prefixes: [],
    });
    expect(group.member_tenants).toEqual(['acme-corp', 'beta-co']);
    expect(group.shared_prefixes).toEqual(['knowledge/confidential/shared/unit-shared/']);
  });

  it('rejects tenant group profiles that violate the shared prefix schema', () => {
    expect(() =>
      writeTenantGroupProfile({
        tenant_group_id: 'unit-shared',
        display_name: 'Unit Shared',
        status: 'active',
        member_tenants: ['acme-corp'],
        shared_prefixes: ['knowledge/public/shared/unit-shared/'],
      }),
    ).toThrow(/invalid tenant group profile/i);
  });
});
