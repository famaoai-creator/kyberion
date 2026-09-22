import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveTraceOrigin,
  exportTraceOtlp,
  finalizeAndPersist,
  persistTrace,
  TraceContext,
} from './trace.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import { validateTraceReplay } from '../trace-schema.js';
import { withTriggerCorrelation } from '../trigger-correlation.js';

const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const originalFetch = globalThis.fetch;
const traceTestDir = pathResolver.sharedTmp(`trace-schema-replay-${process.pid}`);

afterEach(() => {
  if (originalEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
  globalThis.fetch = originalFetch;
  safeRmSync(traceTestDir, { recursive: true, force: true });
});

describe('trace OTLP bridge', () => {
  it('type-checks exact attributes for governed span names', () => {
    const context = new TraceContext('workflow.test');
    context.startSpan('mission', { mission_id: 'M1' });
    // @ts-expect-error governed span attributes reject undeclared keys
    context.startSpan('mission', { undeclared: true });
    context.endSpan('ok');
  });

  it('is disabled unless an OTLP endpoint is configured', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const trace = new TraceContext('workflow.test').finalize();
    expect(await exportTraceOtlp(trace)).toBe(false);
  });

  it('projects nested Kyberion spans into OTLP/HTTP JSON', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    let request: { url: string; body: string } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = { url: String(input), body: String(init?.body || '') };
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const context = new TraceContext('workflow.test', { pipelineId: 'p-test' });
    context.startSpan('step.judge');
    context.addEvent('judge.route_selected', { matched: true });
    context.endSpan('ok');
    const trace = context.finalize();

    expect(await exportTraceOtlp(trace)).toBe(true);
    expect(request?.url).toBe('http://127.0.0.1:4318/v1/traces');
    const body = JSON.parse(request?.body || '{}');
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
    expect(body.resourceSpans[0].scopeSpans[0].spans[1].name).toBe('step.judge');
  });

  it('validates persisted traces at the write boundary and replays the persisted record', () => {
    const persisted = finalizeAndPersist(new TraceContext('workflow.replay'), {
      dir: traceTestDir,
    });
    const record = JSON.parse(
      String(safeReadFile(persisted.path, { encoding: 'utf8' })).trim()
    ) as unknown;
    expect(validateTraceReplay(record)).toEqual([]);

    const malformed = {
      traceId: 'trace-invalid',
      rootSpan: {
        name: 'workflow.replay',
        status: 'invalid',
        events: [],
        children: [],
      },
    };
    expect(() => persistTrace(malformed as never, { dir: traceTestDir })).toThrow(
      '[TRACE_SCHEMA_INVALID]'
    );
  });

  it('rejects a trace log directory that traverses a symbolic link', () => {
    const targetDir = pathResolver.sharedTmp(`trace-log-target-${process.pid}`);
    const linkedDir = pathResolver.sharedTmp(`trace-log-link-${process.pid}`);
    safeMkdir(targetDir, { recursive: true });
    safeSymlinkSync(targetDir, linkedDir, 'dir');
    try {
      expect(() =>
        persistTrace(new TraceContext('workflow.symlink').finalize(), { dir: linkedDir })
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      safeRmSync(linkedDir, { recursive: true, force: true });
      safeRmSync(targetDir, { recursive: true, force: true });
    }
  });
});

describe('WI-13: deriveTraceOrigin priority table', () => {
  it('VITEST set -> test, regardless of anything else', () => {
    expect(
      deriveTraceOrigin('cron:nightly:2026-09-22T00:00', {
        VITEST: '1',
        CI: '1',
        MISSION_ROLE: 'mission_controller',
      })
    ).toBe('test');
  });

  it('CI set (no VITEST) -> ci', () => {
    expect(
      deriveTraceOrigin('cron:nightly:2026-09-22T00:00', {
        CI: '1',
        MISSION_ROLE: 'mission_controller',
      })
    ).toBe('ci');
  });

  it('a cron:-prefixed correlationId (no VITEST/CI) -> scheduled', () => {
    expect(deriveTraceOrigin('cron:nightly:2026-09-22T00:00', {})).toBe('scheduled');
    expect(deriveTraceOrigin('cron:nightly:2026-09-22T00:00', { MISSION_ROLE: 'x' })).toBe(
      'scheduled'
    );
  });

  it('an ambient cron trigger delivery scope -> scheduled', () => {
    const cron = { deliveryId: 'd1', source: 'cron' as const, idempotencyKey: 'cron:x:1' };
    expect(deriveTraceOrigin(undefined, {}, cron)).toBe('scheduled');
    expect(deriveTraceOrigin(undefined, {}, { ...cron, source: 'watch' })).toBe('interactive');
  });

  it('TraceContext inside withTriggerCorrelation(cron) is scheduled when not under vitest', () => {
    // The real process has VITEST set, so exercise the ambient read through
    // deriveTraceOrigin's default `trigger` argument with an injected env.
    const inside = withTriggerCorrelation(
      { deliveryId: 'd2', source: 'cron', idempotencyKey: 'cron:nightly:2026-09-22T00:00' },
      () => deriveTraceOrigin(undefined, {})
    );
    expect(inside).toBe('scheduled');
    expect(deriveTraceOrigin(undefined, {})).toBe('interactive');
  });

  it('a valid KYBERION_RUN_ORIGIN wins right after VITEST/CI; an invalid one is ignored', () => {
    expect(deriveTraceOrigin(undefined, { KYBERION_RUN_ORIGIN: 'scheduled' })).toBe('scheduled');
    expect(
      deriveTraceOrigin(undefined, {
        KYBERION_RUN_ORIGIN: 'interactive',
        KYBERION_NHI_ID: 'kyberion://agent/x/y',
      })
    ).toBe('interactive');
    expect(deriveTraceOrigin(undefined, { KYBERION_RUN_ORIGIN: 'agent' })).toBe('agent');
    expect(deriveTraceOrigin(undefined, { KYBERION_RUN_ORIGIN: 'scheduled', CI: '1' })).toBe('ci');
    expect(deriveTraceOrigin(undefined, { KYBERION_RUN_ORIGIN: 'test' })).toBe('interactive');
    expect(deriveTraceOrigin(undefined, { KYBERION_RUN_ORIGIN: 'bogus' })).toBe('interactive');
  });

  it('an agent-runtime identity env (no VITEST/CI/cron correlation) -> agent', () => {
    expect(deriveTraceOrigin(undefined, { KYBERION_NHI_ID: 'kyberion://agent/x/y' })).toBe('agent');
    expect(deriveTraceOrigin(undefined, { KYBERION_AGENT_ID: 'agent-1' })).toBe('agent');
  });

  it('MISSION_ROLE alone (set by pnpm pipeline / withExecutionContext) is interactive, not agent', () => {
    expect(deriveTraceOrigin(undefined, { MISSION_ROLE: 'mission_controller' })).toBe(
      'interactive'
    );
    expect(deriveTraceOrigin(undefined, { MISSION_ROLE: 'run_pipeline' })).toBe('interactive');
  });

  it('none of the above -> interactive', () => {
    expect(deriveTraceOrigin(undefined, {})).toBe('interactive');
    expect(deriveTraceOrigin('not-a-cron-id', {})).toBe('interactive');
  });

  it('TraceContext sets metadata.origin from the derivation, overridable by explicit metadata', () => {
    const derived = new TraceContext('workflow.origin-default').finalize();
    expect(derived.metadata.origin).toBe('test'); // real process.env.VITEST is set in this run

    const overridden = new TraceContext('workflow.origin-override', {
      origin: 'agent',
    }).finalize();
    expect(overridden.metadata.origin).toBe('agent');
  });
});

describe('WI-13: vitest trace-persistence guard', () => {
  const savedOptIn = process.env.KYBERION_TRACE_TEST_PERSIST;
  const savedCustomer = process.env.KYBERION_CUSTOMER;

  afterEach(() => {
    if (savedOptIn === undefined) delete process.env.KYBERION_TRACE_TEST_PERSIST;
    else process.env.KYBERION_TRACE_TEST_PERSIST = savedOptIn;
    if (savedCustomer === undefined) delete process.env.KYBERION_CUSTOMER;
    else process.env.KYBERION_CUSTOMER = savedCustomer;
  });

  it('an explicit dir always persists for real, opt-in or not', () => {
    const trace = new TraceContext('workflow.explicit-dir-always-writes').finalize();
    const filePath = persistTrace(trace, { dir: traceTestDir });
    expect(safeExistsSync(filePath)).toBe(true);
    const content = String(safeReadFile(filePath, { encoding: 'utf8' }));
    expect(content).toContain(trace.traceId);
  });

  it('skips the write under vitest with no explicit dir and no opt-in, but returns the same path shape', () => {
    delete process.env.KYBERION_TRACE_TEST_PERSIST;
    delete process.env.KYBERION_CUSTOMER;

    const expectedDir = pathResolver.shared('logs/traces');
    const today = new Date().toISOString().slice(0, 10);
    const expectedFile = path.join(expectedDir, `traces-${today}.jsonl`);
    const before = safeExistsSync(expectedFile)
      ? String(safeReadFile(expectedFile, { encoding: 'utf8' }))
      : undefined;

    const trace = new TraceContext('workflow.skip-guard-default').finalize();
    const returned = persistTrace(trace);

    expect(returned).toBe(expectedFile);
    const after = safeExistsSync(expectedFile)
      ? String(safeReadFile(expectedFile, { encoding: 'utf8' }))
      : undefined;
    expect(after).toBe(before); // nothing new appended; trace id never landed on disk
    if (after !== undefined) expect(after).not.toContain(trace.traceId);
  });

  it('KYBERION_TRACE_TEST_PERSIST=1 re-enables persistence to the default (resolved) dir', () => {
    delete process.env.KYBERION_CUSTOMER;
    process.env.KYBERION_TRACE_TEST_PERSIST = '1';

    // customerIsConfigured() only redirects to customer/{slug}/logs/traces/
    // once that directory already exists on disk (customer-resolver.ts), so
    // proving the opt-in re-enables persistence means writing to — and
    // precisely restoring — the real default dir's day file.
    const expectedDir = pathResolver.shared('logs/traces');
    const today = new Date().toISOString().slice(0, 10);
    const expectedFile = path.join(expectedDir, `traces-${today}.jsonl`);
    const existedBefore = safeExistsSync(expectedFile);
    const before = existedBefore
      ? String(safeReadFile(expectedFile, { encoding: 'utf8' }))
      : undefined;

    try {
      const trace = new TraceContext('workflow.skip-guard-optin').finalize();
      const returned = persistTrace(trace);
      expect(returned).toBe(expectedFile);
      expect(safeExistsSync(returned)).toBe(true);
      const content = String(safeReadFile(returned, { encoding: 'utf8' }));
      expect(content).toContain(trace.traceId);
    } finally {
      if (existedBefore) safeWriteFile(expectedFile, before ?? '', { encoding: 'utf8' });
      else safeRmSync(expectedFile, { force: true });
    }
  });
});
