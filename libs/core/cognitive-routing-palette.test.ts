import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { buildCognitiveRouteDecision } from './cognitive-routing.js';
import {
  resolveRoutingOptimizeMode,
  ROUTING_OPTIMIZE_FOR_ENV,
} from './cognitive-routing-palette.js';
import {
  admitRoutingCompare,
  classifyRoutingTaxonomy,
  planRoutingCompare,
  runRoutingCompare,
} from './routing-compare.js';

describe('cognitive routing palettes', () => {
  afterEach(() => {
    delete process.env[ROUTING_OPTIMIZE_FOR_ENV];
  });

  it('normalizes Cursor-style balanced to balance', () => {
    expect(resolveRoutingOptimizeMode('balanced')).toBe('balance');
  });

  it('keeps a single-bug turn on fast_llm in balance and cost, and upgrades in intelligence', () => {
    const input = {
      mission_id: 'MSN-PALETTE-001',
      title: 'Fix a small bug',
      description: 'Fix a small bug in the parser output.',
    };
    expect(buildCognitiveRouteDecision({ ...input, optimize_for: 'cost' }).tier).toBe('fast_llm');
    expect(buildCognitiveRouteDecision({ ...input, optimize_for: 'balance' }).tier).toBe(
      'fast_llm'
    );
    expect(buildCognitiveRouteDecision({ ...input, optimize_for: 'intelligence' }).tier).toBe(
      'heavy_reasoning'
    );
  });
});

describe('routing compare', () => {
  it('classifies a visual frontend bug', () => {
    expect(classifyRoutingTaxonomy('Fix the CSS layout bug on the settings page')).toMatchObject({
      domain: 'frontend',
      task: 'debug',
      modifier: 'visual-heavy',
    });
  });

  it('plans a dry comparison without executing backends', async () => {
    const result = await runRoutingCompare({
      instruction: 'Summarize the ticket and close the issue.',
      explicit: true,
      live: false,
    });
    expect(result.executed).toBe(false);
    expect(result.plan.admission.run).toBe(true);
    expect(result.plan.cognitive.tier).toBe('fast_llm');
    expect(result.comparison).toBeUndefined();
  });

  it('keeps cost mode from fan-out unless the operator asks', () => {
    const plan = planRoutingCompare({
      instruction: 'Investigate the architecture and compare security alternatives.',
      optimizeFor: 'cost',
    });
    expect(plan.admission.run).toBe(false);
    expect(
      admitRoutingCompare({
        optimizeFor: 'cost',
        explicit: true,
        cognitive: plan.cognitive,
      }).run
    ).toBe(true);
  });

  it('executes a live comparison through injected backends and records a digest-only log', async () => {
    const logPath = path.join(
      pathResolver.sharedTmp(`routing-compare-${process.pid}`),
      'comparisons.jsonl'
    );
    const result = await runRoutingCompare({
      instruction: 'Compare two implementations of the same helper.',
      explicit: true,
      live: true,
      dataTier: 'public',
      providers: ['claude', 'grok'],
      comparisonLogPath: logPath,
      seams: {
        getBackend: (provider) => ({
          delegateTask: async () => `answer from ${provider}`,
        }),
        verdictLogPath: path.join(path.dirname(logPath), 'verdicts.jsonl'),
      },
    });
    expect(result.executed).toBe(true);
    expect(result.comparison?.winner?.provider).toBeTruthy();
    expect(result.plan.instruction_digest).toHaveLength(16);
  });
});
