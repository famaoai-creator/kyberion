import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { detectTier } from './tier-guard.js';
import { checkFiniteStateSafety, type SafetyModel } from './testing/finite-state-checker.js';
import type { TierLevel } from './types.js';

const tiers = ['public', 'confidential', 'personal'] as const;
const actualRoot = pathResolver.rootDir();
const base = path.join(actualRoot, 'active/shared/tmp/system/tier-path-model');
const ancestorFamilies = ['scratch', 'artifact', 'runtime', 'knowledge'] as const;
const ancestorSegment = {
  scratch: 'active/shared/tmp',
  artifact: 'active/shared/artifacts',
  runtime: 'active/shared/runtime/workspaces',
  knowledge: 'knowledge',
};
const layouts: { name: string; root: string; ancestorTier?: TierLevel }[] = [
  { name: 'plain', root: path.join(base, 'plain-checkout') },
  ...ancestorFamilies.flatMap((family) =>
    tiers.map((tier) => ({
      name: `${family}-${tier}`,
      root: path.join(base, ancestorSegment[family], tier, 'shared/checkout'),
      ancestorTier: tier,
    }))
  ),
];

// Expected tiers are declared from each address's own partition, not parsed
// from the absolute spelling by the production matchers.
const innerFamilies = [
  'knowledge',
  'active/shared/artifacts',
  'active/shared/staging',
  'active/shared/cache',
  'active/shared/tmp',
  'active/shared/runtime/workspaces',
  'active/shared/runtime/tenant-ledger',
  'active/organizations',
  'active/projects',
];
const items: { relative: string; tier: TierLevel }[] = [
  ...innerFamilies.flatMap((family) =>
    tiers.map((tier) => ({
      relative: `${family}/${tier}/acme/result.json`,
      tier,
    }))
  ),
  ...[
    'README.md',
    'libs/core/index.ts',
    'active/shared/tmp/system/job/out.md',
    'active/shared/artifacts/system/job/out.md',
    'active/shared/runtime/workspaces/system/job/out.md',
    // Metrics retain their deliberate legacy-public classification.
    'active/shared/runtime/usage-ledger/confidential/acme/counts.jsonl',
  ].map((relative) => ({ relative, tier: 'public' as const })),
];

interface State {
  layout: number;
  item: number;
  classified: TierLevel;
}
function model(ancestorFirst = false): SafetyModel<State> {
  return {
    initial: items.map(({ tier }, item) => ({ layout: 0, item, classified: tier })),
    key: JSON.stringify,
    next: (current) =>
      current.layout === 0
        ? layouts.slice(1).map((layout, index) => ({
            action: `relocate:${layout.name}`,
            state: {
              layout: index + 1,
              item: current.item,
              classified: ancestorFirst ? layout.ancestorTier! : items[current.item]!.tier,
            },
          }))
        : [],
    invariants: {
      'checkout ancestors cannot change the inner address tier': (current) =>
        current.classified === items[current.item]!.tier,
    },
  };
}

let root = actualRoot;
let primary = actualRoot;
beforeEach(() => {
  root = actualRoot;
  primary = actualRoot;
  vi.spyOn(pathResolver, 'rootDir').mockImplementation(() => root);
  vi.spyOn(pathResolver, 'primaryCheckoutRootDir').mockImplementation(() => primary);
});
afterEach(() => vi.restoreAllMocks());

describe('tier path relocation model', () => {
  it('preserves confidential knowledge under a public scratch checkout', () => {
    root = layouts.find((layout) => layout.name === 'scratch-public')!.root;
    expect(detectTier(path.join(root, 'knowledge/confidential/acme/secret.md'))).toBe(
      'confidential'
    );
  });

  it('exhausts 13 ancestor layouts and 33 inner path partitions', () => {
    expect(checkFiniteStateSafety(model())).toEqual({
      status: 'verified',
      visited: 429,
      transitions: 396,
    });
  });

  it('rejects an ancestor-first classifier with a relocation counterexample', () => {
    const result = checkFiniteStateSafety(model(true));
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('checkout ancestors cannot change the inner address tier');
    expect(result.trace).toHaveLength(2);
    expect(result.trace?.at(-1)?.action).toMatch(/^relocate:/u);
  });

  const cases = layouts.flatMap((layout) =>
    items.map((item) => ({
      name: layout.name,
      root: layout.root,
      ...item,
    }))
  );
  it.each(cases)('classifies $relative as $tier below $name', (sample) => {
    root = sample.root;
    expect(detectTier(path.join(root, sample.relative))).toBe(sample.tier);
  });

  it('classifies the checkout directory itself without inheriting an ancestor tier', () => {
    for (const layout of layouts) {
      root = layout.root;
      expect(detectTier(root)).toBe('public');
    }
  });

  it('retains root-independent detection for genuinely outside-root paths', () => {
    root = path.join(base, 'current-checkout');
    primary = root;
    for (const sample of items.slice(0, innerFamilies.length * tiers.length)) {
      expect(detectTier(path.join(base, 'other-checkout', sample.relative))).toBe(sample.tier);
    }
    expect(detectTier(path.join(base, 'other-checkout/ordinary.txt'))).toBe('public');
    expect(
      detectTier(
        path.join(base, 'other-checkout/active/shared/artifacts/public/shared/knowledge/personal/x')
      )
    ).toBe('personal');
  });

  it('does not invent a logical checkout for an unrelated outside path', () => {
    root = path.join(base, 'current-checkout');
    primary = root;
    expect(
      detectTier(
        path.join(base, 'active/shared/tmp/public/shared/other/knowledge/confidential/acme/x')
      )
    ).toBe('public');
  });

  it('uses the primary checkout policy spelling for shared authority stores', () => {
    root = path.join(base, 'active/shared/tmp/public/shared/linked-checkout');
    primary = path.join(base, 'knowledge/personal/primary-checkout');
    expect(
      detectTier(
        path.join(
          primary,
          'active/shared/runtime/tenant-approvals/confidential/acme/channel/request.json'
        )
      )
    ).toBe('confidential');
    expect(detectTier(path.join(primary, 'knowledge/confidential/acme/charters/team.json'))).toBe(
      'confidential'
    );
    expect(detectTier(path.join(primary, 'knowledge/personal/charters/owner.json'))).toBe(
      'personal'
    );
  });
});
