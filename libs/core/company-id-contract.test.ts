import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCompany } from './company.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

/**
 * Pins the contract Chronos' customer-decision overview route relies on
 * (presence/displays/chronos-mirror-v2/src/app/api/customer-decisions/overview/route.ts):
 * a tenant's company id IS its tenant slug, so the route checks the viewer's
 * organization scope against the slug without loading the company aggregate.
 * If company ids ever stop being the slug, this fails — change that route too.
 */
describe('company id contract', () => {
  const tmpRoot = pathResolver.sharedTmp(`company-id-contract-${randomUUID()}`);

  afterEach(() => {
    if (safeExistsSync(tmpRoot)) safeRmSync(tmpRoot, { recursive: true, force: true });
  });

  it('uses the tenant slug as company_id, whatever the company records say', () => {
    safeMkdir(`${tmpRoot}/customer/acme`, { recursive: true });
    safeWriteFile(
      `${tmpRoot}/customer/acme/customer.json`,
      JSON.stringify({ slug: 'acme', company_id: 'other-co', display_name: 'ACME Inc.' })
    );
    safeWriteFile(
      `${tmpRoot}/customer/acme/organization-profile.json`,
      JSON.stringify({ version: '1.0.0', organization_id: 'other-org', name: 'ACME' })
    );
    expect(resolveCompany('acme', tmpRoot).company_id).toBe('acme');
  });

  it('uses the tenant slug as company_id for a tenant without any records', () => {
    safeMkdir(tmpRoot, { recursive: true });
    expect(resolveCompany('globex', tmpRoot).company_id).toBe('globex');
  });
});
