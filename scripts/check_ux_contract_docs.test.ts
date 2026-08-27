import { describe, expect, it } from 'vitest';
import { checkUxContractDocs } from './check_ux_contract_docs.js';

describe('UX contract docs', () => {
  it('keeps the public front door in plain language', () => {
    expect(checkUxContractDocs()).toEqual([]);
  });
});
