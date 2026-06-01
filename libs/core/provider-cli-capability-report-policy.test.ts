import { describe, expect, it } from 'vitest';

import {
  loadProviderCliCapabilityReportPolicyCatalog,
  resolveProviderCliCapabilityReportPolicy,
} from './provider-cli-capability-report-policy.js';

describe('provider-cli-capability-report-policy', () => {
  it('loads the canonical provider report labels', () => {
    const catalog = loadProviderCliCapabilityReportPolicyCatalog();
    expect(catalog.title).toBe('Provider CLI Capability Report');
    expect(catalog.summary_title).toBe('Summary');
    expect(catalog.capability_inventory_title).toBe('Capability Inventory');
  });

  it('resolves the policy object', () => {
    expect(resolveProviderCliCapabilityReportPolicy().missing_adapter_title).toBe('Missing Adapter Coverage');
  });
});
