import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnManagedProcess } from '../managed-process.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { readJson } from '../foundation/json.js';
import { enableDotEventContinuation } from './dot-lifecycle.js';
import type { DotCharter } from './dot-charter.js';
import {
  evaluateDotEventTriggers,
  ingestLocalEvent,
  readDotInboundEvents,
  type EventIntakePolicy,
} from './dot-event-intake.js';
import { inspectDotEventIntake } from './dot-event-intake-diagnostics.js';
import {
  claimEventContinuation,
  eventContinuationPath,
  readEventContinuation,
  initialEventContinuation,
  writeEventContinuation,
  reconcileEventRunnerTerminal,
  EVENT_CONTINUATION_PENDING,
} from './dot-event-continuation.js';
import type { DotWakeTool } from './dot-extensions.js';
import { DOT_WAKE_TOOLS } from './dot-extension-registry.js';
import { recordDotWakeOutcome, runDotWake } from './dot-runtime.js';

const ROOT = 'active/shared/tmp/dot-event-continuation-tests';
const NOW = new Date('2026-10-12T12:00:00Z');
const deps = { rootDir: ROOT, now: () => NOW };
const policy: EventIntakePolicy = {
  version: '1.0.0',
  sources: {
    fixture: {
      enabled: false,
      signature_header: 'x-signature',
      secret_key: 'EVENT_INTAKE_FIXTURE_SECRET',
      event_type_header: 'x-type',
      delivery_id_header: 'x-delivery',
      max_body_bytes: 65536,
    },
  },
};
function charter(): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: 'continuation-fixture',
    version: '1.0.0',
    title: 'Synthetic fixture',
    purpose: 'Offline continuation tests',
    status: 'paused',
    scope: { tier: 'public' },
    goal: { statement: 'Synthetic work only' },
    attention: { triggers: [{ kind: 'event', sources: ['fixture'] }] },
    authority: { authority_role: 'infrastructure_sentinel' },
    notification: { deliver_to: { surface: 'slack', channel: '#unused' } },
    runtime: { heartbeat_id: 'continuation-fixture' },
  };
}
function initialize(): DotCharter {
  safeMkdir(ROOT + '/dots', { recursive: true });
  const c = charter();
  safeWriteFile(ROOT + '/dots/fixture.json', JSON.stringify(c));
  return enableDotEventContinuation(c.dot_id, { ...deps, confirmQuiescent: true });
}
function ingest(i: number, blob = '') {
  const result = ingestLocalEvent({
    source: 'fixture',
    deliveryId: 'delivery-' + i,
    body: { sequence: i, blob },
    policy,
    rootDir: ROOT,
    now: NOW,
  });
  expect(result.status).toBe('accepted');
  return result.event;
}
function child(code: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const { child: p } = spawnManagedProcess({
      resourceId: 'event-continuation-test-' + randomUUID(),
      kind: 'service',
      ownerId: 'event-continuation-tests',
      ownerType: 'test',
      command: process.execPath,
      args: ['--import', './scripts/ts-loader.mjs', '--input-type=module', '-e', code],
      spawnOptions: {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KYBERION_PERSONA: 'mission_owner',
          KYBERION_WISDOM_LLM_PROFILE: 'stub',
          KYBERION_REASONING_BACKEND: 'stub',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    });
    let output = '';
    p.stdout!.on('data', (data) => {
      output += String(data);
    });
    p.stderr!.on('data', (data) => {
      output += String(data);
    });
    p.once('error', reject);
    p.once('close', (code) => resolve({ code, output }));
  });
}
// Match the built package imports: one authority/lock singleton graph in each child.
const childImports =
  "import {safeReadFile,safeAppendFileSync} from '@agent/core/secure-io';" +
  "import {withExecutionContextAsync} from '@agent/core/authority';" +
  "import {evaluateDotEventTriggers} from '@agent/core/dot/dot-event-intake';" +
  "import {claimEventContinuation} from '@agent/core/dot/dot-event-intake';" +
  "import {recordDotWakeOutcome} from '@agent/core/dot/dot-runtime';";
afterEach(() => {
  if (safeExistsSync(ROOT)) safeRmSync(ROOT, { recursive: true, force: true });
});

describe('forward-only event continuation', () => {
  it('truthfully demonstrates 2001 accepted legacy rows outside the 2000-row scan', () => {
    let first = '';
    for (let i = 0; i < 2001; i++) {
      const event = ingest(i);
      if (!i) first = event.event_id;
    }
    const raw = String(
      safeReadFile(ROOT + '/active/shared/runtime/dot/events.jsonl', { encoding: 'utf8' })
    );
    expect(raw.trim().split('\n')).toHaveLength(2001);
    expect(readDotInboundEvents(undefined, deps)).toHaveLength(2000);
    expect(evaluateDotEventTriggers(charter(), deps).some((d) => d.key === 'event:' + first)).toBe(
      false
    );
    expect(inspectDotEventIntake(charter(), deps)).toMatchObject({
      mode: 'legacy',
      row_cutoff: true,
      history_outside_window: true,
      total_pending: null,
    });
  }, 120000);

  it('retains all 2001 accepted new rows, bounds pending, and resumes in a new process without duplicate simulated effects', async () => {
    const c = initialize();
    for (let i = 0; i < 2001; i++) ingest(i);
    const due = evaluateDotEventTriggers(c, deps);
    expect(due).toHaveLength(5);
    expect(readEventContinuation(c, deps)?.pending).toHaveLength(EVENT_CONTINUATION_PENDING);
    for (const offer of due) {
      const id = claimEventContinuation(c, offer, deps)!;
      safeAppendFileSync(ROOT + '/effects.jsonl', JSON.stringify(offer.key) + '\n');
      recordDotWakeOutcome(c, offer, 'delivered', { ...deps, eventAttemptId: id });
    }
    const code =
      childImports +
      "await withExecutionContextAsync('mission_owner',async()=>{" +
      'const root=' +
      JSON.stringify(ROOT) +
      ";const c=JSON.parse(safeReadFile(root+'/dots/fixture.json',{encoding:'utf8'}));" +
      "const deps={rootDir:root,now:()=>new Date('2026-10-12T12:00:00Z')};" +
      'let count=0;for(let sweep=0;sweep<500;sweep++){const due=evaluateDotEventTriggers(c,deps);if(!due.length)break;' +
      "for(const d of due){const id=claimEventContinuation(c,d,deps);safeAppendFileSync(root+'/effects.jsonl',JSON.stringify(d.key)+'\\n');recordDotWakeOutcome(c,d,'delivered',{...deps,eventAttemptId:id});count++;}}" +
      "console.log('resumed='+count);},'mission_owner');";
    const resumed = await child(code);
    expect(resumed, resumed.output).toMatchObject({ code: 0 });
    expect(resumed.output).toContain('resumed=1996');
    const effects = String(safeReadFile(ROOT + '/effects.jsonl', { encoding: 'utf8' }))
      .trim()
      .split('\n');
    expect(effects).toHaveLength(2001);
    expect(new Set(effects).size).toBe(2001);
    expect(evaluateDotEventTriggers(c, deps)).toEqual([]);
    expect(readEventContinuation(c, deps)?.pending).toEqual([]);
  }, 180000);

  it('does not replay historical rows, acknowledge offers, or age pending work out', () => {
    ingest(0);
    const c = initialize();
    expect(evaluateDotEventTriggers(c, deps)).toEqual([]);
    ingest(1);
    const first = evaluateDotEventTriggers(c, deps);
    expect(
      evaluateDotEventTriggers(c, { ...deps, now: () => new Date(NOW.getTime() + 7 * 86400000) })
    ).toEqual(first);
    expect(readEventContinuation(c, deps)?.pending).toHaveLength(1);
    recordDotWakeOutcome(c, first[0], 'skipped', deps);
    expect(evaluateDotEventTriggers(c, deps)).toEqual(first);
  });

  it('retries pre-dispatch failure with backoff, but never expires dispatched failure or crash ambiguity', () => {
    const c = initialize();
    ingest(0);
    const [offer] = evaluateDotEventTriggers(c, deps);
    recordDotWakeOutcome(c, offer, 'failed', deps);
    expect(evaluateDotEventTriggers(c, deps)).toEqual([]);
    const later = { ...deps, now: () => new Date(NOW.getTime() + 3600000) };
    expect(evaluateDotEventTriggers(c, later)).toHaveLength(1);
    const attempt = claimEventContinuation(c, offer, later)!;
    recordDotWakeOutcome(c, offer, 'failed', { ...later, eventAttemptId: attempt });
    expect(
      evaluateDotEventTriggers(c, { ...deps, now: () => new Date(NOW.getTime() + 30 * 86400000) })
    ).toEqual([]);
    expect(() => claimEventContinuation(c, offer, later)).toThrow(/unresolved/);
    recordDotWakeOutcome(c, offer, 'delivered', { ...later, eventAttemptId: 'wrong-attempt' });
    expect(evaluateDotEventTriggers(c, later)).toEqual([]);
    expect(readEventContinuation(c, deps)?.pending).toHaveLength(1);
    recordDotWakeOutcome(c, offer, 'delivered', { ...later, eventAttemptId: attempt });
    expect(evaluateDotEventTriggers(c, later)).toEqual([]);
    expect(readEventContinuation(c, deps)?.pending).toEqual([]);
  });

  it('uses one cross-process claim winner; an abandoned claim remains held after restart', async () => {
    const c = initialize();
    ingest(0);
    const [offer] = evaluateDotEventTriggers(c, deps);
    const code =
      childImports +
      "await withExecutionContextAsync('mission_owner',async()=>{try{" +
      'const c=' +
      JSON.stringify(c) +
      ';const offer=' +
      JSON.stringify(offer) +
      ';' +
      'claimEventContinuation(c,offer,{rootDir:' +
      JSON.stringify(ROOT) +
      '});' +
      'safeAppendFileSync(' +
      JSON.stringify(ROOT + '/claims') +
      ",'effect\\n');" +
      "}catch(e){process.exitCode=2;}},'mission_owner');";
    const results = await Promise.all([child(code), child(code)]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 2]);
    expect(String(safeReadFile(ROOT + '/claims', { encoding: 'utf8' }))).toBe('effect\n');
    expect(evaluateDotEventTriggers(c, { ...deps, now: () => new Date('2027-01-01') })).toEqual([]);
  }, 30000);

  it('holds missing, malformed, changed-trigger and truncated state without resetting it', () => {
    const c = initialize();
    ingest(0);
    evaluateDotEventTriggers(c, deps);
    const file = eventContinuationPath(c, ROOT);
    const original = safeReadFile(file);
    const changed = {
      ...c,
      attention: { ...c.attention, triggers: [{ kind: 'event' as const, sources: ['other'] }] },
    };
    expect(() => evaluateDotEventTriggers(changed, deps)).toThrow(/held/);
    safeWriteFile(file, '{}');
    expect(() => evaluateDotEventTriggers(c, deps)).toThrow(/held/);
    expect(inspectDotEventIntake(c, deps)).toMatchObject({ state: 'held' });
    safeWriteFile(file, original);
    safeWriteFile(ROOT + '/active/shared/runtime/dot/events.jsonl', '');
    expect(() => evaluateDotEventTriggers(c, deps)).toThrow(/held/);
    safeRmSync(file);
    expect(() => evaluateDotEventTriggers(c, deps)).toThrow(/missing/);
    expect(safeExistsSync(file)).toBe(false);
  });

  it('diagnoses the byte window independently and never mutates state during status reads', () => {
    for (let i = 0; i < 270; i++) ingest(i, 'x'.repeat(16000));
    const c = charter();
    const file = ROOT + '/active/shared/runtime/dot/events.jsonl';
    const before = safeReadFile(file);
    expect(inspectDotEventIntake(c, deps)).toMatchObject({
      byte_cutoff: true,
      history_outside_window: true,
      total_pending: null,
    });
    expect(safeReadFile(file)).toEqual(before);
    expect(safeExistsSync(eventContinuationPath(c, ROOT))).toBe(false);
  }, 120000);

  it('requires explicit quiescence, refuses reinitialization, and never changes status', () => {
    const c = initialize();
    expect(c.status).toBe('paused');
    expect(() => enableDotEventContinuation(c.dot_id, { ...deps, confirmQuiescent: true })).toThrow(
      /already/
    );
    expect(() =>
      enableDotEventContinuation(c.dot_id, { ...deps, confirmQuiescent: false })
    ).toThrow(/quiescence/);
    expect(readJson<DotCharter>(ROOT + '/dots/fixture.json').status).toBe('paused');
  });
});

describe('continuation dispatch and evidence boundaries', () => {
  function active(c: DotCharter): DotCharter {
    const next = { ...c, status: 'active' as const };
    safeWriteFile(ROOT + '/dots/fixture.json', JSON.stringify(next));
    return next;
  }
  it('persists the claim before the injected provider and reconciles a matching terminal receipt', async () => {
    const c = active(initialize());
    ingest(0);
    const [trigger] = evaluateDotEventTriggers(c, deps);
    const runLoop = vi.fn(async () => {
      expect(readEventContinuation(c, deps)?.pending[0].attempt?.id).toBeTruthy();
      return { finalState: 'complete', turnsRun: 1, goal: { budgetStats: { tokensUsed: 0 } } };
    });
    const result = await runDotWake(
      { path: ROOT + '/dots/fixture.json', charter: c },
      {
        ...deps,
        trigger,
        hasRole: () => true,
        backend: { delegateTask: async () => '' },
        runLoop,
        opsAlert: vi.fn(),
      }
    );
    expect(result.outcome).toBe('delivered');
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(evaluateDotEventTriggers(c, deps)).toEqual([]);
    expect(readEventContinuation(c, deps)?.pending).toEqual([]);
  });

  it('never falls back or retries after an injected provider may have effected work', async () => {
    const c = active(initialize());
    ingest(0);
    const [trigger] = evaluateDotEventTriggers(c, deps);
    const delegateTask = vi.fn(async () => '');
    const runLoop = vi.fn(async () => {
      throw new Error('generateWithTools unavailable after ambiguous dispatch');
    });
    const loaded = { path: ROOT + '/dots/fixture.json', charter: c };
    const execution = {
      ...deps,
      trigger,
      hasRole: () => true,
      backend: { delegateTask },
      runLoop,
      opsAlert: vi.fn(),
    };
    expect((await runDotWake(loaded, execution)).outcome).toBe('failed');
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(delegateTask).not.toHaveBeenCalled();
    expect(readEventContinuation(c, deps)?.pending[0].attempt).toBeTruthy();
    expect((await runDotWake(loaded, execution)).outcome).toBe('failed');
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(evaluateDotEventTriggers(c, { ...deps, now: () => new Date('2027-01-01') })).toEqual([]);
  });

  it('leaves a backend-resolution failure unclaimed and fences a stale legacy offer after adoption', async () => {
    const legacy = charter();
    const c = active(initialize());
    ingest(0);
    const [trigger] = evaluateDotEventTriggers(c, deps);
    const provider = vi.fn(async () => '');
    const result = await runDotWake(
      { path: ROOT + '/dots/fixture.json', charter: c },
      {
        ...deps,
        trigger,
        hasRole: () => true,
        resolveWakeExecution: async () => {
          throw new Error('known pre-dispatch unavailable');
        },
        backend: { delegateTask: provider },
        opsAlert: vi.fn(),
      }
    );
    expect(result.outcome).toBe('failed');
    expect(readEventContinuation(c, deps)?.pending[0].attempt).toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
    const stale = await runDotWake(
      { path: ROOT + '/dots/fixture.json', charter: legacy },
      {
        ...deps,
        trigger: {
          ...trigger,
          key: 'event:' + readEventContinuation(c, deps)!.pending[0].event_id,
        },
        hasRole: () => true,
        backend: { delegateTask: provider },
        opsAlert: vi.fn(),
      }
    );
    expect(stale.outcome).toBe('failed');
    expect(provider).not.toHaveBeenCalled();
  });

  it('keeps full-scope keys independent while sharing the tenant-bound source ledger', () => {
    const base = charter();
    const c1: DotCharter = {
      ...base,
      scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'one', project_id: 'p' },
      attention: {
        ...base.attention,
        event_delivery: { mode: 'durable', activation_id: '11111111-1111-1111-1111-111111111111' },
      },
    };
    const c2: DotCharter = { ...c1, scope: { ...c1.scope, organization_id: 'two' } };
    const tenantPolicy = {
      ...policy,
      sources: { fixture: { ...policy.sources.fixture, tenant_slug: 'acme' } },
    };
    expect(
      ingestLocalEvent({
        source: 'fixture',
        deliveryId: 'historical',
        body: { n: -1 },
        policy: tenantPolicy,
        rootDir: ROOT,
        now: NOW,
      }).status
    ).toBe('accepted');
    writeEventContinuation(
      c1,
      initialEventContinuation(c1, c1.attention.event_delivery!.activation_id, deps),
      deps,
      true
    );
    writeEventContinuation(
      c2,
      initialEventContinuation(c2, c2.attention.event_delivery!.activation_id, deps),
      deps,
      true
    );
    expect(
      ingestLocalEvent({
        source: 'fixture',
        deliveryId: 'new',
        body: { n: 1 },
        policy: tenantPolicy,
        rootDir: ROOT,
        now: NOW,
      }).status
    ).toBe('accepted');
    const [one] = evaluateDotEventTriggers(c1, deps);
    const [two] = evaluateDotEventTriggers(c2, deps);
    expect(one.key).not.toBe(two.key);
    expect(eventContinuationPath(c1, ROOT)).not.toBe(eventContinuationPath(c2, ROOT));
    const attempt = claimEventContinuation(c1, one, deps)!;
    recordDotWakeOutcome(c1, one, 'delivered', { ...deps, eventAttemptId: attempt });
    expect(evaluateDotEventTriggers(c1, deps)).toEqual([]);
    expect(evaluateDotEventTriggers(c2, deps).map((x) => x.key)).toEqual([two.key]);
    expect(evaluateDotEventTriggers(base, deps)).toEqual([]);
  });

  it('caps scanned lines, retains trailing fragments and holds malformed complete records', () => {
    const c = initialize();
    const file = ROOT + '/active/shared/runtime/dot/events.jsonl';
    safeAppendFileSync(file, '\n'.repeat(2001));
    evaluateDotEventTriggers(c, deps);
    expect(readEventContinuation(c, deps)?.source.offset).toBe(2000);
    evaluateDotEventTriggers(c, deps);
    expect(readEventContinuation(c, deps)?.source.offset).toBe(2001);
    safeAppendFileSync(file, '{"partial":');
    evaluateDotEventTriggers(c, deps);
    expect(readEventContinuation(c, deps)?.source.offset).toBe(2001);
    safeAppendFileSync(file, '\n');
    expect(() => evaluateDotEventTriggers(c, deps)).toThrow(/malformed/);
    expect(readEventContinuation(c, deps)?.source.offset).toBe(2001);
  });

  it('never treats a runner duplicate as terminal and reconciles only the exact scoped event key', () => {
    const c = initialize();
    ingest(0);
    const [offer] = evaluateDotEventTriggers(c, deps);
    reconcileEventRunnerTerminal(
      c,
      offer.key,
      { idempotencyKey: 'dot:' + c.dot_id + ':' + offer.key, status: 'duplicate' },
      deps
    );
    reconcileEventRunnerTerminal(
      c,
      offer.key,
      { idempotencyKey: 'wrong', status: 'delivered' },
      deps
    );
    expect(readEventContinuation(c, deps)?.pending).toHaveLength(1);
    reconcileEventRunnerTerminal(
      c,
      offer.key,
      { idempotencyKey: 'dot:' + c.dot_id + ':' + offer.key, status: 'rejected' },
      deps
    );
    expect(readEventContinuation(c, deps)?.pending).toEqual([]);
  });

  it('holds an orphan snapshot and reports durable status without advancing or acknowledging anything', () => {
    const c = initialize();
    ingest(0);
    evaluateDotEventTriggers(c, deps);
    const file = eventContinuationPath(c, ROOT);
    const bytes = safeReadFile(file);
    expect(inspectDotEventIntake(c, deps)).toMatchObject({ mode: 'durable', recorded_pending: 1 });
    expect(safeReadFile(file)).toEqual(bytes);
    const old = charter();
    safeWriteFile(ROOT + '/dots/fixture.json', JSON.stringify(old));
    expect(() => evaluateDotEventTriggers(old, deps)).toThrow(/without its charter/);
    expect(inspectDotEventIntake(old, deps)).toMatchObject({ state: 'held' });
    expect(safeReadFile(file)).toEqual(bytes);
  });
});

describe('durable terminal-result validation', () => {
  it('retains a partial-effect wake-tool exception rather than acknowledging delivery', async () => {
    const c = { ...initialize(), status: 'active' as const };
    safeWriteFile(ROOT + '/dots/fixture.json', JSON.stringify(c));
    ingest(0);
    const [trigger] = evaluateDotEventTriggers(c, deps);
    const tool: DotWakeTool = {
      name: 'synthetic_partial_effect',
      fence: 'synthetic_partial_effect',
      definition: {
        name: 'synthetic_partial_effect',
        description: 'Synthetic only',
        inputSchema: { type: 'object', properties: {} },
      },
      maxPerWake: 1,
      parse: (input: unknown) => ({ ok: true as const, value: input }),
      apply: () => {
        safeAppendFileSync(ROOT + '/partial-effects', 'once\n');
        throw new Error('uncertain after effect');
      },
    };
    DOT_WAKE_TOOLS.push(tool);
    try {
      const result = await runDotWake(
        { path: ROOT + '/dots/fixture.json', charter: c },
        {
          ...deps,
          trigger,
          hasRole: () => true,
          backend: { delegateTask: async () => '' },
          opsAlert: vi.fn(),
          runLoop: async (options) => {
            options.executeTool!({ name: tool.name, input: {} });
            return {
              finalState: 'complete',
              turnsRun: 1,
              goal: { budgetStats: { tokensUsed: 0 } },
            };
          },
        }
      );
      expect(result.outcome).toBe('failed');
      expect(readEventContinuation(c, deps)?.pending[0].attempt).toBeTruthy();
      expect(evaluateDotEventTriggers(c, deps)).toEqual([]);
      expect(String(safeReadFile(ROOT + '/partial-effects', { encoding: 'utf8' }))).toBe('once\n');
    } finally {
      DOT_WAKE_TOOLS.splice(DOT_WAKE_TOOLS.indexOf(tool), 1);
    }
  });

  it('holds a timed-out/blocked goal result even if the injected driver returns normally', async () => {
    const c = { ...initialize(), status: 'active' as const };
    safeWriteFile(ROOT + '/dots/fixture.json', JSON.stringify(c));
    ingest(0);
    const [trigger] = evaluateDotEventTriggers(c, deps);
    const result = await runDotWake(
      { path: ROOT + '/dots/fixture.json', charter: c },
      {
        ...deps,
        trigger,
        hasRole: () => true,
        backend: { delegateTask: async () => '' },
        opsAlert: vi.fn(),
        runLoop: async () => ({
          finalState: 'blocked',
          turnsRun: 0,
          goal: { budgetStats: { tokensUsed: 3 } },
        }),
      }
    );
    expect(result.outcome).toBe('failed');
    expect(readEventContinuation(c, deps)?.pending[0].attempt).toBeTruthy();
    expect(evaluateDotEventTriggers(c, { ...deps, now: () => new Date('2027-01-01') })).toEqual([]);
  });

  it('rejects active adoption and a torn adoption boundary', () => {
    safeMkdir(ROOT + '/dots', { recursive: true });
    safeWriteFile(ROOT + '/dots/fixture.json', JSON.stringify({ ...charter(), status: 'active' }));
    expect(() =>
      enableDotEventContinuation(charter().dot_id, { ...deps, confirmQuiescent: true })
    ).toThrow(/draft or paused/);
    safeWriteFile(ROOT + '/dots/fixture.json', JSON.stringify(charter()));
    safeWriteFile(ROOT + '/active/shared/runtime/dot/events.jsonl', '{"torn":');
    expect(() =>
      enableDotEventContinuation(charter().dot_id, { ...deps, confirmQuiescent: true })
    ).toThrow(/complete line/);
    expect(safeExistsSync(eventContinuationPath(charter(), ROOT))).toBe(false);
    expect(
      readJson<DotCharter>(ROOT + '/dots/fixture.json').attention.event_delivery
    ).toBeUndefined();
  });
});
