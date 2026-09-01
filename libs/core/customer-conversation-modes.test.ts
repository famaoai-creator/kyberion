import { describe, expect, it } from 'vitest';
import {
  loadSupportGrounding,
  readDealRequirementsCapture,
} from './customer-conversation-modes.js';

describe('customer conversation requirements paths', () => {
  it('rejects traversal-shaped tenant and deal identifiers before reading', () => {
    expect(() => readDealRequirementsCapture('../other-tenant', 'DEAL-ABC')).toThrow(
      /DEAL_SCOPE|tenant/i
    );
    expect(() => readDealRequirementsCapture('tenant-acme', '../outside')).toThrow(
      /DEAL_SCOPE|deal/i
    );
  });

  it('rejects invalid tenant scope before loading support grounding', () => {
    expect(() => loadSupportGrounding('../other-tenant')).toThrow(/CUSTOMER_SCOPE|tenant/i);
  });
});
