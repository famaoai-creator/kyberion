import { afterEach, describe, expect, it } from 'vitest';
import { resolveCompany } from './company.js';
import { resolveVision } from './vision-resolver.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('company', () => {
  const tmpRoot = pathResolver.sharedTmp('company-resolver-test');

  afterEach(() => {
    if (safeExistsSync(tmpRoot)) {
      safeRmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('resolves a company aggregate from customer overlay files', () => {
    safeMkdir(`${tmpRoot}/customer/acme/organization`, { recursive: true });
    safeMkdir(`${tmpRoot}/knowledge/confidential/acme/organization`, { recursive: true });
    safeMkdir(`${tmpRoot}/knowledge/confidential/acme/finance`, { recursive: true });
    safeMkdir(`${tmpRoot}/knowledge/confidential/acme/governance`, { recursive: true });
    safeMkdir(`${tmpRoot}/vision`, { recursive: true });

    safeWriteFile(
      `${tmpRoot}/customer/acme/customer.json`,
      JSON.stringify(
        {
          slug: 'acme',
          display_name: 'ACME Inc.',
          primary_contact: { name: 'Aki' },
        },
        null,
        2
      )
    );
    safeWriteFile(
      `${tmpRoot}/customer/acme/identity.json`,
      JSON.stringify(
        {
          name: 'Sovereign Aki',
          language: 'ja',
        },
        null,
        2
      )
    );
    safeWriteFile(
      `${tmpRoot}/customer/acme/organization-profile.json`,
      JSON.stringify(
        {
          version: '1.0.0',
          organization_id: 'acme',
          name: 'ACME Organization Profile',
          mission_defaults: {
            default_team_template: 'default',
          },
          team_defaults: {
            default_team_template: 'default',
          },
          llm: {
            default_profile: 'standard',
          },
        },
        null,
        2
      )
    );
    safeWriteFile(
      `${tmpRoot}/customer/acme/vision.md`,
      `# ACME Vision\n\n## Soul\n- Build with intention\n\n## Steering\n- Prefer clarity over cleverness\n\n## Destination\n- Make the company legible to agents\n`
    );
    safeWriteFile(
      `${tmpRoot}/customer/acme/org-chart.json`,
      JSON.stringify(
        {
          version: '1.0.0',
          organization_id: 'acme',
          name: 'ACME Org Chart',
          source_kind: 'customer',
          source_path: 'placeholder',
          domains: [
            { domain_id: 'leadership_strategy', name: 'Leadership & Strategy', role_ids: ['ceo'] },
          ],
          positions: [
            {
              role_id: 'ceo',
              reports_to: null,
              held_by: 'human',
              responsibility_scope: 'Sets the direction.',
              authority_role_ref: 'ecosystem_architect',
            },
          ],
        },
        null,
        2
      )
    );
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
              revenue_jpy: 1200000,
              operating_cost_jpy: 800000,
              gross_profit_jpy: 400000,
            },
          ],
        },
        null,
        2
      )
    );
    safeWriteFile(
      `${tmpRoot}/knowledge/confidential/acme/governance/decision-rights.json`,
      JSON.stringify(
        {
          version: '1.0.0',
          company_id: 'acme',
          tenant_slug: 'acme',
          source_kind: 'confidential',
          source_path: 'placeholder',
          decisions: [
            {
              decision_type: 'operational_spend',
              authorized_role: 'finance_controller',
              threshold: { metric: 'amount_jpy', value: 250000, unit: 'JPY' },
              requires_review_from: 'ceo',
              escalates_to: 'ceo',
            },
          ],
        },
        null,
        2
      )
    );
    safeWriteFile(
      `${tmpRoot}/knowledge/product/governance/decision-rights.json`,
      JSON.stringify(
        {
          version: '1.0.0',
          company_id: 'default',
          tenant_slug: null,
          source_kind: 'public',
          source_path: 'knowledge/product/governance/decision-rights.json',
          decisions: [
            {
              decision_type: 'operational_spend',
              authorized_role: 'finance_controller',
              threshold: { metric: 'amount_jpy', value: 500000, unit: 'JPY' },
            },
          ],
        },
        null,
        2
      )
    );
    safeWriteFile(`${tmpRoot}/vision/_default.md`, '# Default Vision\n\nFallback text.');

    const company = resolveCompany('acme', tmpRoot);

    expect(company.company_id).toBe('acme');
    expect(company.name).toBe('ACME Inc.');
    expect(company.sovereign).toBe('Sovereign Aki');
    expect(company.customer_ref.exists).toBe(true);
    expect(company.identity_ref.exists).toBe(true);
    expect(company.organization_profile_ref.data?.organization_id).toBe('acme');
    expect(company.vision_ref.source_kind).toBe('customer');
    expect(company.vision_ref.sections.soul).toEqual(['Build with intention']);
    expect(company.org_chart_ref.data?.positions[0].role_id).toBe('ceo');
    expect(company.financial_ref.exists).toBe(true);
    expect(company.financial_ref.data?.periods).toHaveLength(1);
    expect(company.financial_ref.data?.periods[0]?.gross_profit_jpy).toBe(400000);
    expect(company.okr_ref.exists).toBe(false);
    expect(company.okr_ref.data?.objectives).toHaveLength(0);
    expect(company.decision_rights_ref.data?.source_kind).toBe('confidential');
    expect(company.decision_rights_ref.data?.decisions).toHaveLength(1);
  });

  it('returns graceful refs when company files are missing', () => {
    safeMkdir(`${tmpRoot}/vision`, { recursive: true });
    safeMkdir(`${tmpRoot}/knowledge/product/governance`, { recursive: true });
    safeWriteFile(`${tmpRoot}/vision/_default.md`, '# Default Vision\n\nFallback text.');
    safeWriteFile(
      `${tmpRoot}/knowledge/product/governance/decision-rights.json`,
      JSON.stringify(
        {
          version: '1.0.0',
          company_id: 'default',
          tenant_slug: null,
          source_kind: 'public',
          source_path: 'knowledge/product/governance/decision-rights.json',
          decisions: [],
        },
        null,
        2
      )
    );

    const company = resolveCompany('missing', tmpRoot);

    expect(company.company_id).toBe('missing');
    expect(company.name).toBe('Default Kyberion Organization Profile');
    expect(company.customer_ref.exists).toBe(false);
    expect(company.identity_ref.exists).toBe(false);
    expect(company.organization_profile_ref.data).not.toBeNull();
    expect(company.vision_ref.source_kind).toBe('global');
    expect(company.org_chart_ref.exists).toBe(true);
    expect(company.org_chart_ref.data?.positions).toHaveLength(0);
    expect(company.financial_ref.exists).toBe(false);
    expect(company.financial_ref.data?.source_kind).toBe('derived');
    expect(company.financial_ref.data?.periods).toHaveLength(0);
    expect(company.okr_ref.exists).toBe(false);
    expect(company.okr_ref.data?.source_kind).toBe('derived');
    expect(company.okr_ref.data?.objectives).toHaveLength(0);
    expect(company.decision_rights_ref.exists).toBe(true);
    expect(company.decision_rights_ref.data?.source_kind).toBe('public');
    expect(company.decision_rights_ref.data?.decisions).toHaveLength(0);
  });
});
