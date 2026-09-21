import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pins = new Map<
  string,
  { seam: string; provider_id: string; purpose?: string; pinnedAt: string; by: string }
>();
const record = vi.fn();
const overlay: {
  rules: Array<Record<string, unknown>>;
  overrides: Record<string, Record<string, { traits: Record<string, number> }>>;
} = { rules: [], overrides: {} };

vi.mock('./seam-selection-rules.js', () => ({
  matchSeamSelectionRule: (
    seam: string,
    request: { purpose?: string; context?: Record<string, string> }
  ) =>
    (
      overlay.rules as Array<{
        seam: string;
        when: { purpose?: string; context?: Record<string, string> };
      }>
    ).find(
      (rule) =>
        rule.seam === seam &&
        (!rule.when.purpose || rule.when.purpose === request.purpose) &&
        Object.entries(rule.when.context ?? {}).every(([k, v]) => request.context?.[k] === v)
    ) ?? null,
  getSeamTraitOverrides: (seam: string) => overlay.overrides[seam] ?? {},
}));

vi.mock('./audit-chain.js', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));
vi.mock('./provider-pins-store.js', () => ({
  loadSeamProviderPin: (seam: string, key: string) => pins.get(`${seam}:${key}`) ?? null,
  pinSeamProviderDecision: (seam: string, key: string, providerId: string, purpose?: string) => {
    const entry = {
      seam,
      provider_id: providerId,
      ...(purpose ? { purpose } : {}),
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
    overlay.rules = [];
    overlay.overrides = {};
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

  const rule = (extra: Record<string, unknown>) => ({
    rule_id: 'r1',
    seam: SEAM,
    when: {},
    prefer: ['lightpanda'],
    set_by: 'user:owner',
    set_at: '2026-09-22T00:00:00.000Z',
    ...extra,
  });

  it('applies an operator rule ahead of the purpose ranking', () => {
    overlay.rules = [rule({ when: { purpose: 'evidence' } })];
    const decision = resolveSeamProviderDecision({
      seam: SEAM,
      candidates: BOTH,
      purpose: 'evidence',
    });
    expect(decision).toMatchObject({
      provider_id: 'lightpanda',
      strategy: 'rule',
      rule_id: 'r1',
      ranked: ['lightpanda', 'playwright-chromium'],
    });
    expect(decision.rationale).toMatch(/operator rule 'r1'/);
  });

  it('matches rules on request context and skips ineligible preferred providers', () => {
    overlay.rules = [rule({ when: { context: { language: 'ja' } } })];
    expect(
      resolveSeamProviderDecision({ seam: SEAM, candidates: BOTH, context: { language: 'en' } })
        .strategy
    ).toBe('default');
    expect(
      resolveSeamProviderDecision({ seam: SEAM, candidates: BOTH, context: { language: 'ja' } })
        .provider_id
    ).toBe('lightpanda');
    const skipped = resolveSeamProviderDecision({
      seam: SEAM,
      context: { language: 'ja' },
      candidates: [
        { id: 'lightpanda', eligible: false, unmet: ['open_tab (multi_tab)'] },
        { id: 'playwright-chromium', eligible: true },
      ],
    });
    expect(skipped.provider_id).toBe('playwright-chromium');
    expect(skipped.rationale).toMatch(/prefers only ineligible providers/);
  });

  it('keeps a mission pin ahead of a later operator rule', () => {
    pins.set(`${SEAM}:evidence`, {
      seam: SEAM,
      provider_id: 'playwright-chromium',
      purpose: 'evidence',
      pinnedAt: '2026-09-22T00:00:00.000Z',
      by: 'test',
    });
    overlay.rules = [rule({ when: { purpose: 'evidence' } })];
    const decision = resolveSeamProviderDecision({
      seam: SEAM,
      candidates: BOTH,
      purpose: 'evidence',
      decisionKey: 'evidence',
    });
    expect(decision.strategy).toBe('pinned');
    expect(decision.provider_id).toBe('playwright-chromium');
  });

  it('does not reuse a mission pin for a different purpose on the same decision key', () => {
    vi.stubEnv('MISSION_ID', 'MSN-TEST');
    resolveSeamProviderDecision({
      seam: SEAM,
      candidates: BOTH,
      purpose: 'throughput',
      decisionKey: 'shared-slot',
    });

    const decision = resolveSeamProviderDecision({
      seam: SEAM,
      candidates: BOTH,
      purpose: 'evidence',
      decisionKey: 'shared-slot',
    });
    expect(decision.strategy).toBe('purpose');
    expect(decision.provider_id).toBe('playwright-chromium');
  });

  it('scores with measured operator trait values and says so', () => {
    overlay.overrides[SEAM] = { 'playwright-chromium': { traits: { speed: 1, footprint: 1 } } };
    const decision = resolveSeamProviderDecision({
      seam: SEAM,
      candidates: BOTH,
      purpose: 'throughput',
    });
    expect(decision.provider_id).toBe('playwright-chromium');
    expect(decision.rationale).toMatch(/speed=0\.6×1 \(measured\)/);
    const baseline = resolveSeamProviderDecision({
      seam: SEAM,
      candidates: BOTH,
      purpose: 'throughput',
      ignoreOperatorOverlay: true,
    });
    expect(baseline.provider_id).toBe('lightpanda');
  });

  it('ranks by the fallback purpose when the default cannot run the task', () => {
    const decision = resolveSeamProviderDecision({
      seam: SEAM,
      candidates: [
        { id: 'lightpanda', eligible: true },
        { id: 'playwright-chromium', eligible: false, unmet: ['test'] },
      ],
    });
    expect(decision).toMatchObject({ provider_id: 'lightpanda', strategy: 'fallback' });
    expect(decision.rationale).toMatch(/fallback purpose 'throughput'/);
  });
});
