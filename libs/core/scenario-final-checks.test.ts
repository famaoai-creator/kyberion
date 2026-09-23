import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import type { ScenarioFinalCheck } from './scenario-definition.js';
import {
  calledOpRecords,
  evaluateFinalCheck,
  evaluateTurnChecks,
  jsonSubsetMatches,
} from './scenario-final-checks.js';
import {
  appendScenarioApproval,
  appendScenarioOp,
  createScenarioSideEffectLog,
  type ScenarioSideEffectLog,
} from './scenario-side-effect-log.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import type { Trace } from './src/trace.js';

const RUN_ROOT = pathResolver.sharedTmp(`scenario-final-checks-${process.pid}`);

afterEach(() => {
  safeRmSync(RUN_ROOT, { recursive: true, force: true });
});

function servedTwice(): ScenarioSideEffectLog {
  const log = createScenarioSideEffectLog();
  for (const target of ['a', 'b']) {
    appendScenarioOp(log, { op: 'demo:apply', stage: 'preflight', source: 'actuator' });
    appendScenarioOp(log, { op: 'demo:apply', stage: 'preflight', source: 'pipeline' });
    appendScenarioOp(log, {
      op: 'demo:apply',
      stage: 'apply',
      params: { target, nested: { keep: true } },
      outcome: 'ok',
    });
  }
  return log;
}

function trace(names: string[]): Trace {
  const span = (name: string) => ({
    spanId: name,
    name,
    startTime: '2020-01-01T00:00:00.000Z',
    status: 'ok' as const,
    events: [],
    artifacts: [],
    knowledgeRefs: [],
    children: [],
  });
  return {
    traceId: 't',
    rootSpan: { ...span('root'), children: names.map(span) },
    metadata: { startedAt: '2020-01-01T00:00:00.000Z' },
  };
}

const ctx = { runRoot: RUN_ROOT };
const check = (c: ScenarioFinalCheck, log: ScenarioSideEffectLog, t?: Trace) =>
  evaluateFinalCheck(c, log, t, ctx);

describe('scenario final checks (ES-05)', () => {
  it('counts each served op once despite the double preflight record', () => {
    const log = servedTwice();
    expect(calledOpRecords(log, 'demo:apply')).toHaveLength(2);
    expect(check({ type: 'opCalled', op: 'demo:apply', times: 2 }, log).pass).toBe(true);
    expect(check({ type: 'opCalled', op: 'demo:apply', times: 1 }, log)).toMatchObject({
      pass: false,
      detail: 'demo:apply called 2 time(s), expected 1 time(s)',
    });
    expect(check({ type: 'opCalled', op: 'demo:apply' }, log).pass).toBe(true);
    expect(check({ type: 'opNotCalled', op: 'demo:apply' }, log).pass).toBe(false);
  });

  it('counts a passthrough op by its pipeline preflight, but not unstubbed or held ops', () => {
    const log = createScenarioSideEffectLog();
    appendScenarioOp(log, { op: 'system:log', stage: 'preflight', source: 'actuator' });
    appendScenarioOp(log, { op: 'system:log', stage: 'preflight', source: 'pipeline' });
    appendScenarioOp(log, { op: 'system:exec', stage: 'preflight', source: 'pipeline' });
    appendScenarioOp(log, { op: 'system:exec', stage: 'unstubbed' });
    appendScenarioOp(log, {
      op: 'demo:gated',
      stage: 'preflight',
      source: 'pipeline',
      requiresApproval: true,
      approvalGranted: false,
    });
    expect(check({ type: 'opCalled', op: 'system:log', times: 1 }, log).pass).toBe(true);
    expect(check({ type: 'opNotCalled', op: 'system:exec' }, log).pass).toBe(true);
    expect(check({ type: 'opNotCalled', op: 'demo:gated' }, log).pass).toBe(true);
  });

  it('matches op params as a JSON subset', () => {
    const log = servedTwice();
    expect(
      check({ type: 'opArgs', op: 'demo:apply', match: { target: 'b', nested: {} } }, log).pass
    ).toBe(true);
    expect(check({ type: 'opArgs', op: 'demo:apply', match: { target: 'c' } }, log).pass).toBe(
      false
    );
    expect(jsonSubsetMatches([1, 2], [1, 2, 3])).toBe(false);
    expect(jsonSubsetMatches({ a: null }, { a: null, b: 1 })).toBe(true);
  });

  it('checks approval requests, transitions, and rejection without side effects', () => {
    const log = createScenarioSideEffectLog();
    appendScenarioApproval(log, {
      op: 'demo:apply',
      kind: 'requested',
      channel: 'pipeline',
      decision: 'rejected',
    });
    appendScenarioOp(log, {
      op: 'demo:apply',
      stage: 'preflight',
      source: 'pipeline',
      requiresApproval: true,
      approvalGranted: false,
    });
    expect(check({ type: 'approvalRequested', op: 'demo:apply' }, log).pass).toBe(true);
    expect(check({ type: 'noSideEffectOnReject', op: 'demo:apply' }, log).pass).toBe(true);
    expect(
      check({ type: 'approvalTransition', op: 'demo:apply', from: 'rejected', to: 'approved' }, log)
        .pass
    ).toBe(false);

    appendScenarioApproval(log, {
      op: 'demo:apply',
      kind: 'decided',
      channel: 'scenario',
      decision: 'approved',
      previous: 'rejected',
    });
    appendScenarioOp(log, { op: 'demo:apply', stage: 'apply', outcome: 'ok' });
    expect(
      check({ type: 'approvalTransition', op: 'demo:apply', from: 'rejected', to: 'approved' }, log)
        .pass
    ).toBe(true);
    // The apply happened after the decision changed, so the rejection stays clean.
    expect(check({ type: 'noSideEffectOnReject', op: 'demo:apply' }, log).pass).toBe(true);
  });

  it('fails noSideEffectOnReject when the op ran while rejected or no rejection was seen', () => {
    const leaked = createScenarioSideEffectLog();
    appendScenarioApproval(leaked, {
      op: 'demo:apply',
      kind: 'requested',
      channel: 'pipeline',
      decision: 'rejected',
    });
    appendScenarioOp(leaked, { op: 'demo:apply', stage: 'apply', outcome: 'ok' });
    expect(check({ type: 'noSideEffectOnReject', op: 'demo:apply' }, leaked).pass).toBe(false);
    expect(
      check({ type: 'noSideEffectOnReject', op: 'demo:apply' }, createScenarioSideEffectLog())
    ).toMatchObject({ pass: false, detail: 'no rejected approval was observed for demo:apply' });
  });

  it('checks artifacts under the run root and refuses escaping paths', () => {
    safeMkdir(`${RUN_ROOT}/out`, { recursive: true });
    safeWriteFile(`${RUN_ROOT}/out/report.json`, '{}');
    const log = createScenarioSideEffectLog();
    expect(check({ type: 'artifactExists', path: 'out/report.json' }, log).pass).toBe(true);
    expect(check({ type: 'artifactExists', path: 'out/missing.json' }, log).pass).toBe(false);
    expect(check({ type: 'artifactExists', path: '../escape.json' }, log)).toMatchObject({
      pass: false,
      detail: expect.stringContaining('escapes the run root'),
    });
  });

  it('finds nested trace spans by name', () => {
    const log = createScenarioSideEffectLog();
    expect(
      check({ type: 'traceSpanExists', name: 'system:log' }, log, trace(['system:log'])).pass
    ).toBe(true);
    expect(check({ type: 'traceSpanExists', name: 'nope' }, log, trace([])).pass).toBe(false);
    expect(check({ type: 'traceSpanExists', name: 'root' }, log, undefined).pass).toBe(false);
  });

  it('evaluates per-turn op checks inside the turn window and response matchers', () => {
    const log = servedTwice();
    const window = { fromSeq: 4, toSeq: 7 };
    const results = evaluateTurnChecks(
      {
        expectedOps: ['demo:apply'],
        forbiddenOps: ['system:exec'],
        responseMatchers: [
          { path: 'thing.id', equals: 'thing-1' },
          { path: 'thing.tags', includes: 'x' },
          { path: 'thing.id', regex: '^thing-\\d$' },
          { path: 'missing.value', includes: 'y' },
        ],
      },
      log,
      window,
      { thing: { id: 'thing-1', tags: ['x'] } }
    );
    expect(results.map((r) => [r.type, r.pass])).toEqual([
      ['expectedOp', true],
      ['forbiddenOp', true],
      ['responseMatcher', true],
      ['responseMatcher', true],
      ['responseMatcher', true],
      ['responseMatcher', false],
    ]);
    expect(calledOpRecords(log, 'demo:apply', window)).toHaveLength(1);
    expect(
      evaluateTurnChecks({ expectedOps: ['demo:apply'] }, log, { fromSeq: 100, toSeq: 200 }, {})[0]
        ?.pass
    ).toBe(false);
  });
});
