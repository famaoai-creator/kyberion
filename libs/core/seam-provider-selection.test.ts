import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pins = new Map<string, { seam: string; provider_id: string; pinnedAt: string; by: string }>();
const record = vi.fn();

vi.mock('./audit-chain.js', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));
vi.mock('./provider-pins-store.js', () => ({
  loadSeamProviderPin: (seam: string, key: string) => pins.get(`${seam}:${key}`) ?? null,
  pinSeamProviderDecision: (seam: string, key: string, providerId: string) => {
    const entry = {
      seam,
      provider_id: providerId,
      pinnedAt: '2026-09-22T00:00:00.000Z',
      by: 'test',
    };
    pins.set(`${seam}:${key}`, entry);
    return entry;
  },
}));

const { listSeamSelectionPurposes, resolveSeamProviderDecision } =
  await import('./seam-provider-selection.js');

const SEAM = 'browser-automation-runtime';
const BOTH = [
  { id: 'lightpanda', eligible: true },
  { id: 'playwright-chromium', eligible: true },
];

describe('seam provider selection', () => {
  beforeEach(() => {
    pins.clear();
    record.mockClear();
    vi.stubEnv('MISSION_ID', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('exposes the governed purposes for the browser runtime seam', () => {
    expect(listSeamSelectionPurposes(SEAM)).toEqual(['authenticated', 'evidence', 'throughput']);
  });

  it('keeps the seam default when no purpose is given', () => {
    const decision = resolveSeamProviderDecision({ seam: SEAM, candidates: BOTH });
    expect(decision).toMatchObject({
      provider_id: 'playwright-chromium',
      strategy: 'default',
      ranked: ['playwright-chromium', 'lightpanda'],
    });
  });

  it('ranks eligible providers by the purpose weights and explains the score', () => {
    const fast = resolveSeamProviderDecision({
      seam: SEAM,
      candidates: BOTH,
      purpose: 'throughput',
    });
    expect(fast.provider_id).toBe('lightpanda');
    expect(fast.ranked).toEqual(['lightpanda', 'playwright-chromium']);
    expect(fast.strategy).toBe('purpose');
    expect(fast.rationale).toMatch(/speed=0\.6×1 \(declared\)/);
    const evidence = resolveSeamProviderDecision({
      seam: SEAM,
      candidates: BOTH,
      purpose: 'evidence',
    });
    expect(evidence.provider_id).toBe('playwright-chromium');
  });

  it('never picks an ineligible provider, whatever the purpose', () => {
    const decision = resolveSeamProviderDecision({
      seam: SEAM,
      purpose: 'throughput',
      candidates: [
        { id: 'lightpanda', eligible: false, unmet: ['screenshot (pixel_screenshots)'] },
        { id: 'playwright-chromium', eligible: true },
      ],
    });
    expect(decision.provider_id).toBe('playwright-chromium');
    expect(decision.excluded).toEqual([
      { id: 'lightpanda', unmet: ['screenshot (pixel_screenshots)'] },
    ]);
  });

  it('fails closed on unknown purposes and when nothing is eligible', () => {
    expect(
      resolveSeamProviderDecision({ seam: SEAM, candidates: BOTH, purpose: 'cheapest' })
    ).toMatchObject({ provider_id: null, strategy: 'unresolved', ranked: [] });
    const none = resolveSeamProviderDecision({
      seam: SEAM,
      purpose: 'throughput',
      candidates: [{ id: 'lightpanda', eligible: false, unmet: ['open_tab (multi_tab)'] }],
    });
    expect(none.provider_id).toBeNull();
    expect(none.rationale).toMatch(/open_tab/);
  });

  it('pins inside a mission, reuses the pin, and never overwrites it with a fallback', () => {
    vi.stubEnv('MISSION_ID', 'MSN-TEST');
    const first = resolveSeamProviderDecision({
      seam: SEAM,
      candidates: BOTH,
      purpose: 'throughput',
      decisionKey: 'throughput',
    });
    expect(first).toMatchObject({ provider_id: 'lightpanda', pinned: true });

    const again = resolveSeamProviderDecision({
      seam: SEAM,
      candidates: BOTH,
      purpose: 'throughput',
      decisionKey: 'throughput',
    });
    expect(again.strategy).toBe('pinned');
    expect(again.ranked[0]).toBe('lightpanda');

    const fallback = resolveSeamProviderDecision({
      seam: SEAM,
      purpose: 'throughput',
      decisionKey: 'throughput',
      candidates: [
        { id: 'lightpanda', eligible: false, unmet: ['open_tab (multi_tab)'] },
        { id: 'playwright-chromium', eligible: true },
      ],
    });
    expect(fallback.provider_id).toBe('playwright-chromium');
    expect(fallback.pinned).toBe(false);
    expect(fallback.rationale).toMatch(/mission pin 'lightpanda' cannot run this task/);
    expect(pins.get(`${SEAM}:throughput`)?.provider_id).toBe('lightpanda');
  });

  it('does not pin outside a mission and records every decision', () => {
    resolveSeamProviderDecision({
      seam: SEAM,
      candidates: BOTH,
      purpose: 'throughput',
      decisionKey: 'throughput',
    });
    expect(pins.size).toBe(0);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'provider_selection',
        operation: `${SEAM}/lightpanda`,
        metadata: expect.objectContaining({ strategy: 'purpose', purpose: 'throughput' }),
      })
    );
  });
});
