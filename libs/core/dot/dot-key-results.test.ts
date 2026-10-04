import { afterEach, describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import type { KeyResultSpec } from '../key-result-spec.js';
import {
  assertDotKrFilePathAllowed,
  dotGoalGapLines,
  measureActiveDotKeyResults,
  measureDotKeyResults,
  measureOrganizationKeyResults,
  readLatestDotKeyResults,
  readOrganizationKrMeasurements,
  DOT_GOAL_GAP_PROMPT_SECTION,
  DOT_KEY_RESULTS_STATUS_SECTION,
} from './dot-key-results.js';
import { rollUpObjectiveProgress } from '../organization/organization-objective-progress.js';

const ROOT = 'active/shared/tmp/dot-key-results-tests';
const T0 = new Date('2026-10-04T00:00:00Z');
const at = (min: number) => () => new Date(T0.getTime() + min * 60_000);

const krs: KeyResultSpec[] = [
  {
    kr_id: 'errors',
    title: 'Error count',
    metric: {
      source: 'file',
      path: 'active/shared/tmp/dot-key-results-tests/m.json',
      json_path: 'a.errors',
    },
    target: 0,
    direction: 'decrease',
    baseline: 10,
    weight: 2,
    every_s: 600,
  },
  {
    kr_id: 'health',
    title: 'Health',
    metric: { source: 'signal_ratio', signal: 'up' },
    target: 100,
    direction: 'increase',
    weight: 1,
  },
];

function charter(
  extra: Partial<DotCharter['goal']> = {},
  scope: Partial<DotCharter['scope']> = {}
): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: 'kr-dot',
    version: '1.0.0',
    title: 'KR dot',
    purpose: 'x',
    status: 'active',
    scope: { tier: 'public', ...scope },
    goal: { statement: 'g', key_results: krs, ...extra },
    attention: { triggers: [] },
    authority: { authority_role: 'infrastructure_sentinel' },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: 'dot-kr-dot' },
  } as DotCharter;
}

afterEach(() => safeRmSync(ROOT, { recursive: true, force: true }));

describe('dot key results', () => {
  it('measures, respects every_s, and ranks the goal gap', async () => {
    let errors = 8;
    const deps = {
      rootDir: undefined,
      readFile: () => JSON.stringify({ a: { errors } }),
      readSignals: () => [
        { dot_id: 'kr-dot', signal: 'up', healthy: true, measured_at: at(-5)().toISOString() },
        { dot_id: 'kr-dot', signal: 'up', healthy: false, measured_at: at(-4)().toISOString() },
      ],
    };
    // A tenant dot may read only its own confidential knowledge / public / state subtree.
    const tenantKrs = krs.map((kr) =>
      kr.metric.source === 'file'
        ? { ...kr, metric: { ...kr.metric, path: 'knowledge/confidential/acme/metrics/m.json' } }
        : kr
    ) as KeyResultSpec[];
    const c = charter({ key_results: tenantKrs }, { tenant_slug: 'acme' });
    const first = await measureDotKeyResults(c, { ...deps, now: at(0) });
    expect(first.map((r) => [r.kr_id, r.value])).toEqual([
      ['errors', 8],
      ['health', 50],
    ]);
    expect(first[0].progress).toBeCloseTo(0.2);

    errors = 4;
    // inside every_s (600s) for errors; health has the 900s default
    expect(await measureDotKeyResults(c, { ...deps, now: at(5) })).toEqual([]);
    const second = await measureDotKeyResults(c, { ...deps, now: at(11) });
    expect(second.map((r) => r.kr_id)).toEqual(['errors']);

    const latest = readLatestDotKeyResults(c);
    expect(latest.get('errors')?.value).toBe(4);
    const lines = dotGoalGapLines(c, { now: at(12) });
    // errors gap 2*(1-0.6)=0.8, health gap 0.5
    expect(lines[0]).toContain('errors');
    expect(lines[1]).toContain('health');
    expect(lines[0]).toContain('trend ↑');
    expect(DOT_GOAL_GAP_PROMPT_SECTION.lines(c, { now: at(12) })[0]).toBe(
      'Largest goal gap first:'
    );
    expect(DOT_KEY_RESULTS_STATUS_SECTION.collect(c, { now: at(12) })).toHaveProperty(
      'key_results'
    );
    safeRmSync('active/shared/runtime/dot/tenants/acme', { recursive: true, force: true });
  });

  it('does not throw on failures and times probes out', async () => {
    const c = charter({
      key_results: [
        {
          kr_id: 'p',
          title: 'P',
          metric: { source: 'probe', probe: { type: 'file', path: 'x', expect: 'exists' } },
          target: 1,
          direction: 'increase',
        },
        {
          kr_id: 'f',
          title: 'F',
          metric: { source: 'file', path: '../../etc/passwd', json_path: 'a' },
          target: 1,
          direction: 'increase',
        },
      ],
    });
    const rows = await measureDotKeyResults(c, {
      now: at(0),
      probeTimeoutMs: 20,
      runProbe: () => new Promise(() => undefined),
    });
    expect(rows).toEqual([]);
    expect(dotGoalGapLines(c)[0]).toContain('not measured yet');
  });

  it('measures org metrics and org objective KRs for the roll-up port', async () => {
    const scope = { organizationId: 'org-x', tenantSlug: 'acme', tier: 'confidential' as const };
    const purpose = {
      objectives: [
        {
          objective_id: 'o1',
          title: 'O1',
          key_results: [
            {
              kr_id: 'inc',
              title: 'Incidents',
              metric: { source: 'org_metric', metric: 'open_incidents' },
              target: 0,
              direction: 'decrease',
              baseline: 4,
            },
          ],
        },
      ],
    } as never;
    const rows = await measureOrganizationKeyResults(scope, {
      now: at(0),
      loadPurpose: () => purpose,
      orgMetric: () => 2,
    });
    expect(rows[0]).toMatchObject({ scope: 'org', objective_id: 'o1', value: 2 });
    expect(readOrganizationKrMeasurements(scope)).toHaveLength(1);
    const rolled = rollUpObjectiveProgress(scope, {
      readMeasurements: (s) => readOrganizationKrMeasurements(s),
      loadPurpose: () => purpose,
    });
    expect(rolled.objectives[0].progress).toBeCloseTo(0.5);
    safeRmSync('active/shared/runtime/dot/tenants/acme', { recursive: true, force: true });
  });

  it('sweep dedupes orgs referenced by several dots', async () => {
    const withRef = (id: string) =>
      ({
        ...charter({ key_results: [] }, { organization_id: 'org-y' }),
        dot_id: id,
        team: { goal_ref: { objective_id: 'o1' } },
      }) as unknown as DotCharter;
    let loads = 0;
    const result = await measureActiveDotKeyResults([withRef('a'), withRef('b')], {
      now: at(0),
      loadPurpose: () => {
        loads += 1;
        return null;
      },
    });
    expect(loads).toBe(1);
    expect(result.orgs_measured).toBe(1);
    safeRmSync('active/shared/runtime/dot/org-kr-ledger.jsonl', { force: true });
    void safeMkdir;
    void safeWriteFile;
  });
});

describe('file metric tenant confinement', () => {
  const fileKr = (p: string): KeyResultSpec => ({
    kr_id: 'leak',
    title: 'Leak',
    metric: { source: 'file', path: p, json_path: 'n' },
    target: 0,
    direction: 'decrease',
  });

  it("a tenant dot cannot read another tenant's confidential knowledge (file never opened)", async () => {
    const reads: string[] = [];
    const c = charter(
      { key_results: [fileKr('knowledge/confidential/globex/kpi.json')] },
      {
        tier: 'confidential',
        tenant_slug: 'acme',
      }
    );
    const rows = await measureDotKeyResults(c, {
      rootDir: ROOT,
      now: at(0),
      readFile: (rel) => {
        reads.push(rel);
        return JSON.stringify({ n: 1 });
      },
    });
    expect(rows).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('allows own confidential, public knowledge and the own state subtree; denies the rest', () => {
    const acme = { tenantSlug: 'acme', stateRoot: 'active/shared/runtime/dot/tenants/acme' };
    expect(() =>
      assertDotKrFilePathAllowed('knowledge/confidential/acme/k.json', acme)
    ).not.toThrow();
    expect(() => assertDotKrFilePathAllowed('knowledge/public/k.json', acme)).not.toThrow();
    expect(() =>
      assertDotKrFilePathAllowed('active/shared/runtime/dot/tenants/acme/x.json', acme)
    ).not.toThrow();
    for (const bad of [
      'knowledge/confidential/globex/k.json',
      'knowledge/confidential/acme/../globex/k.json',
      'knowledge/personal/me.json',
      'active/shared/runtime/dot/tenants/globex/x.json',
      'active/shared/tmp/m.json',
      '/etc/passwd',
      '../outside.json',
    ]) {
      expect(() => assertDotKrFilePathAllowed(bad, acme), bad).toThrow();
    }
    expect(() => assertDotKrFilePathAllowed('active/shared/tmp/m.json', {})).not.toThrow();
    for (const bad of [
      'knowledge/confidential/acme/k.json',
      'knowledge/personal/me.json',
      'active/shared/runtime/dot/tenants/acme/x.json',
    ]) {
      expect(() => assertDotKrFilePathAllowed(bad, {}), bad).toThrow();
    }
  });

  it('measures each charter inside its own execution context', async () => {
    const seen: string[] = [];
    await measureActiveDotKeyResults(
      [
        charter({ key_results: [] }, { tier: 'confidential', tenant_slug: 'acme' }),
        charter({ key_results: [] }),
      ],
      {
        rootDir: ROOT,
        runAs: async (c, fn) => {
          seen.push(`${c.authority.authority_role}:${c.scope.tenant_slug ?? '-'}`);
          return fn();
        },
      }
    );
    expect(seen).toEqual(['infrastructure_sentinel:acme', 'infrastructure_sentinel:-']);
  });
});
