import { afterEach, describe, expect, it } from 'vitest';
import { resolveDecisionRightsMatrix } from './decision-rights.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('decision-rights', () => {
  const tmpRoot = pathResolver.sharedTmp('decision-rights-resolver-test');

  afterEach(() => {
    if (safeExistsSync(tmpRoot)) {
      safeRmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('loads tenant overrides before the public default', () => {
    safeMkdir(`${tmpRoot}/customer/acme`, { recursive: true });
    safeMkdir(`${tmpRoot}/knowledge/product/governance`, { recursive: true });
    safeWriteFile(
      `${tmpRoot}/customer/acme/decision-rights.json`,
      JSON.stringify(
        {
          version: '1.0.0',
          company_id: 'acme',
          tenant_slug: 'acme',
          source_kind: 'customer',
          source_path: 'placeholder',
          decisions: [
            {
              decision_type: 'contract_signature',
              authorized_role: 'legal_strategist',
              threshold: { metric: 'risk_level', value: 'low' },
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
          decisions: [],
        },
        null,
        2
      )
    );

    const matrix = resolveDecisionRightsMatrix('acme', tmpRoot);

    expect(matrix.source_kind).toBe('customer');
    expect(matrix.company_id).toBe('acme');
    expect(matrix.decisions).toHaveLength(1);
    expect(matrix.decisions[0]?.decision_type).toBe('contract_signature');
  });

  it('falls back to public defaults when tenant data is missing', () => {
    safeMkdir(`${tmpRoot}/knowledge/product/governance`, { recursive: true });
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

    const matrix = resolveDecisionRightsMatrix('missing', tmpRoot);

    expect(matrix.source_kind).toBe('public');
    expect(matrix.company_id).toBe('missing');
    expect(matrix.decisions).toHaveLength(0);
  });
});
