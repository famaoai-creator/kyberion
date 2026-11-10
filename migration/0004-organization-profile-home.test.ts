import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { planOrganizationProfileMoves } from './0004-organization-profile-home.js';

// secure-io only reads inside the repository: keep the fixture on the scratch floor.
const root = pathResolver.sharedTmp(`org-profile-home-${process.pid}`);

function write(rel: string, value: unknown): void {
  const file = path.join(root, rel);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(value));
}

afterEach(() => {
  if (safeExistsSync(root)) safeRmSync(root, { recursive: true, force: true });
});

describe('0004-organization-profile-home migration plan', () => {
  it('moves each tenant-root profile into its own organization and skips conflicts', () => {
    write('knowledge/confidential/acme/organization-profile.json', { organization_id: 'acme' });
    write('knowledge/confidential/globex/organization-profile.json', { organization_id: 'ops' });
    write('knowledge/confidential/globex/organizations/ops/organization-profile.json', {
      organization_id: 'ops',
    });
    write('knowledge/confidential/broken/organization-profile.json', { organization_id: '../x' });
    // Reserved scope names are never tenants and are never visited.
    write('knowledge/confidential/shared/organization-profile.json', { organization_id: 's' });

    const { moves, skipped } = planOrganizationProfileMoves(root);
    expect(
      moves.map((move) => ({
        tenant: move.tenant,
        from: path.relative(root, move.from),
        to: path.relative(root, move.to),
      }))
    ).toEqual([
      {
        tenant: 'acme',
        from: 'knowledge/confidential/acme/organization-profile.json',
        to: 'knowledge/confidential/acme/organizations/acme/organization-profile.json',
      },
    ]);
    expect(skipped.map((skip) => [skip.tenant, skip.reason])).toEqual([
      ['broken', 'invalid_organization_id'],
      ['globex', 'target_exists'],
    ]);
  });

  it('plans nothing once every profile lives under its organization', () => {
    write('knowledge/confidential/acme/organizations/acme/organization-profile.json', {
      organization_id: 'acme',
    });
    expect(planOrganizationProfileMoves(root)).toEqual({ moves: [], skipped: [] });
  });
});
