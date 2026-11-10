import { describe, expect, it } from 'vitest';
import { parseVolatileSidecar } from './volatile-knowledge.js';

const base = {
  $schema: '../../../schemas/volatile-knowledge.schema.json',
  scope: 'mission',
  scope_ref: 'MSN-VOLATILE-NOMINATED',
  cadence: 'resident',
  period_key: null,
  tier: 'public',
  lifetime: 'mission',
  expires_at: null,
  created_at: '2026-11-10T00:00:00.000Z',
  updated_at: '2026-11-10T00:00:00.000Z',
  rollover_to: null,
  rollup_to: null,
  promote_target: null,
  promotion_candidate_id: 'MEM-1',
  pinned: false,
};

describe('volatile sidecar nominated status (D8 / M3)', () => {
  it('reads the canonical nominated status', () => {
    expect(parseVolatileSidecar({ ...base, status: 'nominated' })?.status).toBe('nominated');
  });

  it('reads the legacy promoted spelling as nominated', () => {
    expect(parseVolatileSidecar({ ...base, status: 'promoted' })?.status).toBe('nominated');
  });

  it('still rejects unknown statuses', () => {
    expect(parseVolatileSidecar({ ...base, status: 'published' })).toBeNull();
  });
});
