import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

import {
  loadProviderCliCapabilityReportPolicyCatalog,
  resolveProviderCliCapabilityReportPolicy,
} from './provider-cli-capability-report-policy.js';

describe('provider-cli-capability-report-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/core/provider-cli-capability-report-policy.ts'),
      { encoding: 'utf8' }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('loads the canonical provider report labels', () => {
    const catalog = loadProviderCliCapabilityReportPolicyCatalog();
    expect(catalog.title).toBe('Provider CLI Capability Report');
    expect(catalog.summary_title).toBe('Summary');
    expect(catalog.capability_inventory_title).toBe('Capability Inventory');
  });

  it('resolves the policy object', () => {
    expect(resolveProviderCliCapabilityReportPolicy().missing_adapter_title).toBe(
      'Missing Adapter Coverage'
    );
  });
});
