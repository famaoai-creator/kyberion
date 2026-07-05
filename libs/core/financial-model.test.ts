import { afterEach, describe, expect, it } from 'vitest';
import { resolveFinancialModel, summarizeFinancialModel } from './financial-model.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('financial-model', () => {
  const tmpRoot = pathResolver.sharedTmp('financial-model-test');

  afterEach(() => {
    if (safeExistsSync(tmpRoot)) {
      safeRmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('loads a structured financial model from confidential storage', () => {
    safeMkdir(`${tmpRoot}/knowledge/confidential/acme/finance`, { recursive: true });
    safeWriteFile(
      `${tmpRoot}/knowledge/confidential/acme/finance/financial-model.json`,
      JSON.stringify(
        {
          company_id: 'acme',
          tenant_slug: 'acme',
          source_kind: 'confidential',
          source_path: 'placeholder',
          periods: [
            {
              period_id: 'fy-2025',
              label: 'FY 2025',
              revenue_jpy: '1200000',
              operating_cost_jpy: '800000',
              gross_profit_jpy: '400000',
            },
          ],
        },
        null,
        2
      )
    );

    const model = resolveFinancialModel('acme', tmpRoot);
    const summary = summarizeFinancialModel(model);

    expect(model.source_kind).toBe('confidential');
    expect(model.periods[0]?.revenue_jpy).toBe(1200000);
    expect(model.periods[0]?.gross_profit_jpy).toBe(400000);
    expect(summary?.period_count).toBe(1);
    expect(summary?.latest_period_id).toBe('fy-2025');
  });

  it('falls back to legacy customer financial fields when no model exists', () => {
    safeMkdir(`${tmpRoot}/customer/acme`, { recursive: true });
    safeWriteFile(
      `${tmpRoot}/customer/acme/customer.json`,
      JSON.stringify(
        {
          display_name: 'ACME Inc.',
          financials_prev_fy: {
            revenue_jpy: '1000000',
            profit_jpy: '250000',
            note: 'legacy',
          },
        },
        null,
        2
      )
    );

    const model = resolveFinancialModel('acme', tmpRoot);

    expect(model.source_kind).toBe('customer');
    expect(model.periods).toHaveLength(1);
    expect(model.periods[0]?.revenue_jpy).toBe(1000000);
    expect(model.periods[0]?.gross_profit_jpy).toBe(250000);
    expect(model.periods[0]?.note).toBe('legacy');
  });
});
