import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import {
  SHADOW_EXIT_MIN_SAMPLES,
  buildObservation,
  classifyPullRequest,
  configurePrShadowRoot,
  listPrShadowRecords,
  observePullRequests,
  summarizePrShadow,
  type PrCiState,
  type PrFile,
  type PrFinalState,
  type PrReadPort,
  type PrSummary,
} from './pr-shadow.js';

const file = (path: string, lines = 10): PrFile => ({ path, additions: lines, deletions: 0 });

class FakePort implements PrReadPort {
  open: PrSummary[] = [];
  filesByPr = new Map<number, PrFile[]>();
  ci = new Map<number, { state: PrCiState; failing: string[] }>();
  final = new Map<number, PrFinalState>();
  ignoredSeen: readonly string[] = [];
  listOpen() {
    return this.open;
  }
  files(pr: number) {
    return this.filesByPr.get(pr) ?? [];
  }
  ciState(pr: number, ignored: readonly string[]) {
    this.ignoredSeen = ignored;
    return this.ci.get(pr) ?? { state: 'success' as const, failing: [] };
  }
  finalState(pr: number) {
    return this.final.get(pr) ?? { state: 'open' as const };
  }
}

const pr = (number: number, overrides: Partial<PrSummary> = {}): PrSummary => ({
  number,
  title: `PR ${number}`,
  headSha: `sha-${number}`,
  isDraft: false,
  ...overrides,
});

describe('classifyPullRequest', () => {
  it('is low risk when only tests, docs and changelog fragments change', () => {
    const result = classifyPullRequest([
      file('docs/guide.md'),
      file('libs/core/x.test.ts'),
      file('changelog.d/x.md'),
    ]);
    expect(result).toMatchObject({ tier: 'low', actionId: 'pr_merge_low' });
    expect(result.gateDecision).not.toBe('approve');
  });

  it('is medium for behavior changes outside the high-risk paths', () => {
    const result = classifyPullRequest([file('libs/core/feature.ts'), file('docs/guide.md')]);
    expect(result).toMatchObject({ tier: 'medium', actionId: 'pr_merge_medium' });
    expect(result.vetoWindowMinutes).toBeGreaterThan(0);
  });

  it('is high when any high-risk path changes, even beside a docs change', () => {
    const result = classifyPullRequest([
      file('docs/guide.md'),
      file('knowledge/product/governance/autonomous-ops-policy.json'),
    ]);
    expect(result.tier).toBe('high');
    expect(result.gateDecision).toBe('approve');
    expect(result.highRiskMatches).toContain(
      'knowledge/product/governance/autonomous-ops-policy.json'
    );
  });

  it('treats a PR with no files as medium, never low', () => {
    expect(classifyPullRequest([]).tier).not.toBe('low');
  });

  it('counts files and changed lines', () => {
    expect(classifyPullRequest([file('docs/a.md', 5), file('docs/b.md', 7)])).toMatchObject({
      filesChanged: 2,
      linesChanged: 12,
    });
  });
});

describe('buildObservation', () => {
  it('only says it would auto-merge when no human is needed and CI is green', () => {
    const medium = classifyPullRequest([file('libs/core/feature.ts')]);
    expect(buildObservation(pr(1), medium, { state: 'success', failing: [] })).toMatchObject({
      would_auto_merge_if_reviewed: true,
      evidence_gaps: ['cross_provider_review'],
    });
    expect(
      buildObservation(pr(1), medium, { state: 'failure', failing: ['lint'] })
        .would_auto_merge_if_reviewed
    ).toBe(false);
    const high = classifyPullRequest([file('.github/workflows/ci.yml')]);
    expect(
      buildObservation(pr(2), high, { state: 'success', failing: [] }).would_auto_merge_if_reviewed
    ).toBe(false);
  });
});

describe('observePullRequests and summarizePrShadow', () => {
  let root = '';

  beforeEach(() => {
    root = pathResolver.sharedTmp(`pr-shadow-${process.pid}-${Date.now()}`);
    configurePrShadowRoot(root);
  });

  afterEach(() => {
    configurePrShadowRoot(undefined);
    safeRmSync(root, { recursive: true, force: true });
  });

  it('writes nothing under vitest unless a root is configured', () => {
    configurePrShadowRoot(undefined);
    const port = new FakePort();
    port.open = [pr(1)];
    port.filesByPr.set(1, [file('docs/a.md')]);
    expect(observePullRequests(port).observed).toBe(0);
    expect(listPrShadowRecords()).toEqual([]);
  });

  it('records a PR once, again when its picture changes, and skips drafts', () => {
    const port = new FakePort();
    port.open = [pr(1), pr(2, { isDraft: true })];
    port.filesByPr.set(1, [file('docs/a.md')]);
    expect(observePullRequests(port)).toMatchObject({ observed: 1, skippedDrafts: 1 });
    expect(observePullRequests(port)).toMatchObject({ observed: 0, unchanged: 1 });
    port.ci.set(1, { state: 'failure', failing: ['lint'] });
    expect(observePullRequests(port).observed).toBe(1);
    port.open = [pr(1, { headSha: 'new' })];
    expect(observePullRequests(port).observed).toBe(1);
    expect(listPrShadowRecords()).toHaveLength(3);
  });

  it('passes the ignored checks to the port', () => {
    const port = new FakePort();
    port.open = [pr(1)];
    port.filesByPr.set(1, [file('docs/a.md')]);
    observePullRequests(port, { ignoredChecks: ['quota-bot'] });
    expect(port.ignoredSeen).toEqual(['quota-bot']);
  });

  it('settles a PR that left the open list and never twice', () => {
    const port = new FakePort();
    port.open = [pr(1)];
    port.filesByPr.set(1, [file('libs/core/feature.ts')]);
    observePullRequests(port);
    port.open = [];
    port.final.set(1, { state: 'merged', at: '2026-10-05T00:00:00Z' });
    expect(observePullRequests(port).outcomes).toBe(1);
    expect(observePullRequests(port).outcomes).toBe(0);
  });

  it('keeps one bad PR from stopping the pass', () => {
    const port = new FakePort();
    port.open = [pr(1), pr(2)];
    port.filesByPr.set(2, [file('docs/a.md')]);
    const original = port.files.bind(port);
    port.files = (n: number) => {
      if (n === 1) throw new Error('gh failed');
      return original(n);
    };
    const result = observePullRequests(port);
    expect(result.observed).toBe(1);
    expect(result.errors).toEqual(['#1: gh failed']);
  });

  it('counts agreement, false positives and merges despite CI per tier', () => {
    const port = new FakePort();
    port.open = [pr(1), pr(2), pr(3), pr(4)];
    port.filesByPr.set(1, [file('docs/a.md')]);
    port.filesByPr.set(2, [file('docs/b.md')]);
    port.filesByPr.set(3, [file('docs/c.md')]);
    port.filesByPr.set(4, [file('.github/workflows/ci.yml')]);
    port.ci.set(3, { state: 'failure', failing: ['tests'] });
    observePullRequests(port);
    port.open = [];
    port.final.set(1, { state: 'merged' });
    port.final.set(2, { state: 'closed' });
    port.final.set(3, { state: 'merged' });
    port.final.set(4, { state: 'merged' });
    observePullRequests(port);
    const summary = summarizePrShadow(listPrShadowRecords());
    expect(summary.observed_prs).toBe(4);
    expect(summary.settled_prs).toBe(4);
    const low = summary.by_tier.find((tier) => tier.tier === 'low');
    expect(low).toMatchObject({
      settled: 3,
      merged: 2,
      closed: 1,
      agreed: 1,
      false_positive: 1,
      merged_despite_ci: 1,
    });
    expect(summary.readiness.low).toContain('not ready: 1 false positive');
    expect(summary.readiness.high).toContain('never leaves shadow mode');
  });

  it('reports collecting until enough PRs settled, then a candidate', () => {
    const records = Array.from(
      { length: SHADOW_EXIT_MIN_SAMPLES },
      (_, index) => index + 1
    ).flatMap((number) => [
      buildObservation(pr(number), classifyPullRequest([file('docs/a.md')]), {
        state: 'success',
        failing: [],
      }),
      { kind: 'outcome' as const, ts: 't', pr: number, state: 'merged' as const },
    ]);
    expect(summarizePrShadow(records.slice(0, 4)).readiness.low).toContain('collecting: 2/30');
    expect(summarizePrShadow(records).readiness.low).toContain('candidate: 30 settled PRs');
  });
});
