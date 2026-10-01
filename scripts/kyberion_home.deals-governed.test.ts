import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withExecutionContext } from '@agent/core/authority';
import { advanceDealStage, getDeal, openDeal } from '@agent/core/deal-store';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core/secure-io';
import { main } from './kyberion_home.js';

// Un-mocked: the real deal store, deal-documents module and tier guard. The
// CLI runs without any outer execution context, as `pnpm kyberion deals` does.
// The home CLI only defaults MISSION_ROLE when it is unset, so pin an ambient
// role that has no customer/ write grant: the deal-document writes must not
// depend on whatever MISSION_ROLE the operator's shell happens to export.
const TENANT = `deal-cli-governed-${process.pid}`;
const TENANT_ROOT = pathResolver.rootResolve(`customer/${TENANT}`);
const previousMissionRole = process.env.MISSION_ROLE;

beforeEach(() => {
  process.env.MISSION_ROLE = 'surface_runtime';
});

afterEach(() => {
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  withExecutionContext('mission_controller', () =>
    safeRmSync(TENANT_ROOT, { recursive: true, force: true })
  );
});

function seedAgreedDeal(): string {
  return withExecutionContext('mission_controller', () => {
    const deal = openDeal({
      tenantSlug: TENANT,
      surface: 'test',
      channelId: 'channel-cli',
      summary: 'CLI contract draft test',
    });
    advanceDealStage({
      tenantSlug: TENANT,
      dealId: deal.deal_id,
      stage: 'quote',
      agreed: { scope: ['governed CLI write'], amount: { value: 1000, currency: 'JPY' } },
    });
    return deal.deal_id;
  });
}

describe('pnpm kyberion deals --draft-contract (governed write, B4)', () => {
  it('drafts the contract into the tenant deal folder through the CLI path', async () => {
    const dealId = seedAgreedDeal();
    const output: unknown[] = [];

    await main(['deals', '--draft-contract', dealId, '--tenant', TENANT, '--json'], (value) =>
      output.push(value)
    );

    const printed = JSON.parse(String(output.at(-1))) as { version: number; contract_ref: string };
    expect(printed.version).toBe(1);
    expect(printed.contract_ref).toBe(`customer/${TENANT}/deals/${dealId}/contract-v1.md`);
    const contractPath = pathResolver.rootResolve(printed.contract_ref);
    expect(safeExistsSync(contractPath)).toBe(true);
    expect(String(safeReadFile(contractPath, { encoding: 'utf8' }))).toContain(
      '- governed CLI write'
    );
    expect(getDeal(TENANT, dealId)?.stage).toBe('contract');
  });

  it('reports an unknown deal in the named tenant without writing', async () => {
    const output: unknown[] = [];
    await expect(
      main(['deals', '--draft-contract', 'DEAL-MISSING', '--tenant', TENANT], (value) =>
        output.push(value)
      )
    ).rejects.toMatchObject({ code: 1 });
    expect(safeExistsSync(pathResolver.rootResolve(`customer/${TENANT}/deals/DEAL-MISSING`))).toBe(
      false
    );
  });
});
