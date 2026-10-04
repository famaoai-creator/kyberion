import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import {
  DOT_EVENT_LOOKBACK_MS,
  DOT_EVENT_PAYLOAD_MAX_BYTES,
  DOT_EVENT_SCAN_TAIL_BYTES,
  dotEventMatchesTrigger,
  dotEventsLedgerPath,
  evaluateDotEventTriggers,
  ingestInboundEvent,
  ingestLocalEvent,
  loadEventIntakePolicy,
  normalizeInboundEvent,
  parseEventJsonPath,
  processInboundEventRequest,
  readDotInboundEvents,
  verifyInboundSignature,
  type EventIntakePolicy,
} from './dot-event-intake.js';
import { recordDotWakeOutcome } from './dot-runtime.js';

const TEST_ROOT = 'active/shared/tmp/dot-event-intake-tests';
const SECRET = 'test-secret-value-0123456789';

const POLICY: EventIntakePolicy = {
  version: '1.0.0',
  sources: {
    github: {
      enabled: true,
      signature_header: 'x-hub-signature-256',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_GITHUB_SECRET',
      event_type_header: 'x-github-event',
      delivery_id_header: 'x-github-delivery',
      max_body_bytes: 65536,
    },
    acme: {
      enabled: true,
      signature_header: 'x-kyberion-signature',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_ACME_SECRET',
      event_type_header: 'x-kyberion-event',
      delivery_id_header: 'x-kyberion-delivery',
      tenant_slug: 'acme',
      max_body_bytes: 1024,
    },
    off: {
      enabled: false,
      signature_header: 'x-kyberion-signature',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_OFF_SECRET',
      event_type_header: 'x-kyberion-event',
      delivery_id_header: 'x-kyberion-delivery',
      max_body_bytes: 1024,
    },
  },
};

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const getSecret = () => SECRET;

function charter(overrides: Partial<DotCharter> = {}): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: 'ci-watcher',
    version: '1.0.0',
    title: 'CI watcher',
    purpose: 'React to CI.',
    status: 'active',
    scope: { tier: 'public' },
    goal: {
      statement: 'Keep CI green.',
      budget: { max_turns_per_wake: 2, wall_clock_ms_per_wake: 60_000, token_cap_per_day: 1000 },
    },
    attention: {
      triggers: [
        {
          kind: 'event',
          sources: ['github'],
          types: ['workflow_run'],
          match: { json_path: '$.workflow_run.conclusion', in: ['failure', 'timed_out'] },
        },
      ],
    },
    authority: { authority_role: 'infrastructure_sentinel' },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: 'dot-ci-watcher' },
    ...overrides,
  };
}

function githubRequest(body: string, delivery: string, type = 'workflow_run') {
  return {
    source: 'github',
    headers: {
      'x-hub-signature-256': sign(body),
      'x-github-event': type,
      'x-github-delivery': delivery,
    },
    body,
    policy: POLICY,
    getSecret,
    rootDir: TEST_ROOT,
  };
}

afterEach(() => {
  if (safeExistsSync(TEST_ROOT)) safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('verifyInboundSignature', () => {
  const body = '{"a":1}';
  it('accepts the matching HMAC and rejects tampering', () => {
    expect(
      verifyInboundSignature({ body, signature: sign(body), secret: SECRET, prefix: 'sha256=' })
    ).toBe(true);
    expect(
      verifyInboundSignature({
        body: '{"a":2}',
        signature: sign(body),
        secret: SECRET,
        prefix: 'sha256=',
      })
    ).toBe(false);
    expect(
      verifyInboundSignature({
        body,
        signature: sign(body, 'other-secret-0123456789'),
        secret: SECRET,
        prefix: 'sha256=',
      })
    ).toBe(false);
  });
  it('fails closed on missing/short secrets, missing header, wrong prefix and bad lengths', () => {
    expect(
      verifyInboundSignature({ body, signature: sign(body), secret: null, prefix: 'sha256=' })
    ).toBe(false);
    expect(
      verifyInboundSignature({
        body,
        signature: sign(body, 'short'),
        secret: 'short',
        prefix: 'sha256=',
      })
    ).toBe(false);
    expect(
      verifyInboundSignature({ body, signature: undefined, secret: SECRET, prefix: 'sha256=' })
    ).toBe(false);
    expect(
      verifyInboundSignature({
        body,
        signature: sign(body).replace('sha256=', 'sha1='),
        secret: SECRET,
        prefix: 'sha256=',
      })
    ).toBe(false);
    expect(
      verifyInboundSignature({
        body,
        signature: `${sign(body)}00`,
        secret: SECRET,
        prefix: 'sha256=',
      })
    ).toBe(false);
    expect(
      verifyInboundSignature({ body, signature: 'sha256=abc', secret: SECRET, prefix: 'sha256=' })
    ).toBe(false);
  });
});

describe('normalizeInboundEvent', () => {
  it('binds tenant only from policy, never from the payload, and digests the raw body', () => {
    const body = JSON.stringify({ tenant_slug: 'evil', title: 'Deploy done' });
    const event = normalizeInboundEvent({
      source: 'acme',
      policy: POLICY,
      headers: { 'x-kyberion-event': 'deploy', 'x-kyberion-delivery': 'd-1' },
      body,
    });
    expect(event.tenant_slug).toBe('acme');
    expect(event.payload_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(event.summary).toContain('acme/deploy');
    expect(event.summary).toContain('title=Deploy done');

    const untenanted = normalizeInboundEvent({
      source: 'github',
      policy: POLICY,
      headers: { 'x-github-event': 'push', 'x-github-delivery': 'g-1' },
      body,
    });
    expect(untenanted.tenant_slug).toBeUndefined();
  });

  it('bounds the stored payload to 16 KB and rejects oversized or non-JSON bodies', () => {
    const big = JSON.stringify({ blob: 'x'.repeat(DOT_EVENT_PAYLOAD_MAX_BYTES + 10) });
    const event = normalizeInboundEvent({
      source: 'github',
      policy: POLICY,
      headers: {},
      body: big,
    });
    expect(event.payload).toEqual({ truncated: true, bytes: Buffer.byteLength(big) });
    expect(event.delivery_id).toMatch(/^digest:/);
    expect(() =>
      normalizeInboundEvent({ source: 'acme', policy: POLICY, headers: {}, body: 'x'.repeat(2000) })
    ).toThrow(/exceeds/);
    expect(() =>
      normalizeInboundEvent({ source: 'github', policy: POLICY, headers: {}, body: 'not json' })
    ).toThrow(/JSON/);
  });
});

describe('processInboundEventRequest + ingest', () => {
  it('accepts a signed event once and reports the redelivery as duplicate', () => {
    const body = JSON.stringify({ workflow_run: { conclusion: 'failure' } });
    const first = processInboundEventRequest(githubRequest(body, 'del-1'));
    expect(first).toMatchObject({ status: 202, result: { status: 'accepted' } });
    const again = processInboundEventRequest(githubRequest(body, 'del-1'));
    expect(again).toMatchObject({ status: 202, result: { status: 'duplicate' } });
    expect(readDotInboundEvents(undefined, { rootDir: TEST_ROOT })).toHaveLength(1);
  });

  it('rejects a replay of the original signed body with changed unsigned delivery and type headers', () => {
    const body = JSON.stringify({ workflow_run: { conclusion: 'failure' } });
    const original = {
      ...githubRequest(body, 'original-delivery'),
      now: new Date('2026-10-04T10:00:00.000Z'),
    };
    expect(processInboundEventRequest(original)).toMatchObject({
      status: 202,
      result: { status: 'accepted' },
    });
    // Reuse the captured body and signature verbatim; only unsigned headers change.
    const replay = {
      ...original,
      headers: {
        ...original.headers,
        'x-github-delivery': 'changed-delivery',
        'x-github-event': 'push',
      },
      now: new Date('2026-10-04T11:00:00.000Z'),
    };
    expect(processInboundEventRequest(replay)).toMatchObject({
      status: 202,
      result: { status: 'duplicate' },
    });
    expect(readDotInboundEvents(undefined, { rootDir: TEST_ROOT })).toMatchObject([
      { delivery_id: 'original-delivery', type: 'workflow_run' },
    ]);
  });

  it('keeps payload replay detection scoped to the authenticated policy source', () => {
    const request = githubRequest('{"status":"failed"}', 'same-delivery');
    expect(processInboundEventRequest(request)).toMatchObject({
      status: 202,
      result: { status: 'accepted' },
    });
    expect(
      processInboundEventRequest({
        ...request,
        source: 'other',
        policy: { ...POLICY, sources: { ...POLICY.sources, other: POLICY.sources.github } },
      })
    ).toMatchObject({ status: 202, result: { status: 'accepted' } });
    expect(
      readDotInboundEvents(undefined, { rootDir: TEST_ROOT }).map((event) => event.source)
    ).toEqual(['github', 'other']);
  });

  it('answers 401 for bad signatures, disabled and unknown sources, 413 for oversize', () => {
    const body = '{"a":1}';
    const bad = {
      ...githubRequest(body, 'x'),
      headers: { 'x-hub-signature-256': sign('{"a":2}') },
    };
    expect(processInboundEventRequest(bad)).toEqual({ status: 401, code: 'bad_signature' });
    expect(processInboundEventRequest({ ...githubRequest(body, 'x'), source: 'off' })).toEqual({
      status: 401,
      code: 'disabled_source',
    });
    expect(processInboundEventRequest({ ...githubRequest(body, 'x'), source: 'nope' })).toEqual({
      status: 401,
      code: 'unknown_source',
    });
    expect(
      processInboundEventRequest({ ...githubRequest(body, 'x'), getSecret: () => null })
    ).toEqual({ status: 401, code: 'bad_signature' });
    expect(
      processInboundEventRequest({ ...githubRequest('x'.repeat(2000), 'x'), source: 'acme' })
    ).toEqual({ status: 413, code: 'too_large' });
    expect(safeExistsSync(`${TEST_ROOT}/${dotEventsLedgerPath()}`)).toBe(false);
  });

  it('writes tenant-bound sources under the tenant namespace', () => {
    const result = ingestLocalEvent({
      source: 'acme',
      body: { tenant_slug: 'other' },
      policy: POLICY,
      rootDir: TEST_ROOT,
    });
    expect(result.ledger).toBe('active/shared/runtime/dot/tenants/acme/events.jsonl');
    expect(result.event.tenant_slug).toBe('acme');
    const raw = String(safeReadFile(`${TEST_ROOT}/${result.ledger}`, { encoding: 'utf8' }));
    expect(raw).toContain(result.event.event_id);
    expect(readDotInboundEvents(undefined, { rootDir: TEST_ROOT })).toHaveLength(0);
  });

  it('local ingest requires a declared source but allows a disabled one', () => {
    expect(() =>
      ingestLocalEvent({ source: 'nope', body: {}, policy: POLICY, rootDir: TEST_ROOT })
    ).toThrow();
    expect(
      ingestLocalEvent({ source: 'off', body: {}, policy: POLICY, rootDir: TEST_ROOT }).status
    ).toBe('accepted');
  });
});

describe('evaluateDotEventTriggers', () => {
  const now = new Date('2026-10-04T12:00:00.000Z');
  const deps = { rootDir: TEST_ROOT, now: () => now };
  const ingest = (
    delivery: string,
    conclusion: string,
    at: Date,
    source = 'github',
    type = 'workflow_run'
  ) =>
    ingestLocalEvent({
      source,
      type,
      deliveryId: delivery,
      body: { workflow_run: { conclusion } },
      policy: POLICY,
      rootDir: TEST_ROOT,
      now: at,
    }).event;

  it('wakes once per matching event and consumes delivered keys', () => {
    const hit = ingest('a', 'failure', new Date(now.getTime() - 60_000));
    ingest('b', 'success', new Date(now.getTime() - 50_000));
    ingest('c', 'failure', new Date(now.getTime() - 40_000), 'github', 'push');
    const due = evaluateDotEventTriggers(charter(), deps);
    expect(due.map((d) => d.key)).toEqual([`event:${hit.event_id}`]);
    expect(due[0].detail).toContain('untrusted external input');

    recordDotWakeOutcome(charter(), due[0], 'delivered', deps);
    expect(evaluateDotEventTriggers(charter(), deps)).toEqual([]);
  });

  it('ignores events older than the newest handled one, but retries failed keys', () => {
    const older = ingest('o', 'failure', new Date(now.getTime() - 120_000));
    const newer = ingest('n', 'failure', new Date(now.getTime() - 60_000));
    const c = charter();
    recordDotWakeOutcome(
      c,
      { trigger: c.attention.triggers[0], key: `event:${older.event_id}` },
      'failed',
      {
        ...deps,
        now: () => new Date(now.getTime() - 3_600_000),
      }
    );
    recordDotWakeOutcome(
      c,
      { trigger: c.attention.triggers[0], key: `event:${newer.event_id}` },
      'delivered',
      deps
    );
    const due = evaluateDotEventTriggers(c, deps);
    expect(due.map((d) => d.key)).toEqual([`event:${older.event_id}`]);
  });

  it('skips events beyond the lookback for a dot that handled none yet', () => {
    ingest('old', 'failure', new Date(now.getTime() - DOT_EVENT_LOOKBACK_MS - 1000));
    expect(evaluateDotEventTriggers(charter(), deps)).toEqual([]);
  });

  it('keeps tenants apart: tenant dots see only their tenant, untenanted dots only the system floor', () => {
    const tenantEvent = ingest('t', 'failure', new Date(now.getTime() - 1000), 'acme');
    const systemEvent = ingest('s', 'failure', new Date(now.getTime() - 1000));
    const anyTrigger = { kind: 'event' as const, sources: ['acme', 'github'] };
    const tenantDot = charter({
      dot_id: 'acme-dot',
      scope: { tier: 'confidential', tenant_slug: 'acme' },
      attention: { triggers: [anyTrigger] },
    });
    const systemDot = charter({ attention: { triggers: [anyTrigger] } });
    const otherTenant = charter({
      dot_id: 'globex-dot',
      scope: { tier: 'confidential', tenant_slug: 'globex' },
      attention: { triggers: [anyTrigger] },
    });
    expect(evaluateDotEventTriggers(tenantDot, deps).map((d) => d.key)).toEqual([
      `event:${tenantEvent.event_id}`,
    ]);
    expect(evaluateDotEventTriggers(systemDot, deps).map((d) => d.key)).toEqual([
      `event:${systemEvent.event_id}`,
    ]);
    expect(evaluateDotEventTriggers(otherTenant, deps)).toEqual([]);
  });

  it('returns nothing for a charter without event triggers', () => {
    ingest('z', 'failure', new Date(now.getTime() - 1000));
    expect(
      evaluateDotEventTriggers(
        charter({ attention: { triggers: [{ kind: 'wake', channels: ['x'] }] } }),
        deps
      )
    ).toEqual([]);
  });
});

describe('match helpers', () => {
  it('parses json paths and never resolves prototype keys', () => {
    expect(parseEventJsonPath('$.a.b[0].c')).toEqual(['a', 'b', '0', 'c']);
    const event = {
      event_id: 'e',
      source: 'github',
      type: 't',
      delivery_id: 'd',
      received_at: '2026-10-04T00:00:00.000Z',
      summary: '',
      payload_digest: 'sha256:x',
      payload: { list: [{ v: 1 }] },
    };
    expect(
      dotEventMatchesTrigger(event, {
        kind: 'event',
        sources: ['github'],
        match: { json_path: '$.list[0].v', equals: 1 },
      })
    ).toBe(true);
    expect(
      dotEventMatchesTrigger(event, {
        kind: 'event',
        sources: ['github'],
        match: { json_path: '$.constructor' },
      })
    ).toBe(false);
    expect(dotEventMatchesTrigger(event, { kind: 'event', sources: ['ci'] })).toBe(false);
  });
});

describe('loadEventIntakePolicy', () => {
  it('ships every source disabled and fails closed on an invalid policy file', () => {
    const shipped = loadEventIntakePolicy();
    expect(Object.keys(shipped.sources).sort()).toEqual(['ci', 'custom', 'email', 'github']);
    expect(Object.values(shipped.sources).every((s) => s.enabled === false)).toBe(true);

    safeMkdir(TEST_ROOT, { recursive: true });
    safeWriteFile(
      `${TEST_ROOT}/bad-policy.json`,
      JSON.stringify({ version: '1', sources: { x: { enabled: true } } })
    );
    expect(loadEventIntakePolicy({ path: `${TEST_ROOT}/bad-policy.json` }).sources).toEqual({});
  });

  it('ingestInboundEvent dedups by source + delivery id', () => {
    const event = normalizeInboundEvent({
      source: 'github',
      policy: POLICY,
      headers: { 'x-github-delivery': 'dup' },
      body: '{}',
    });
    expect(ingestInboundEvent(event, { rootDir: TEST_ROOT }).status).toBe('accepted');
    expect(
      ingestInboundEvent(
        { ...event, received_at: new Date().toISOString() },
        { rootDir: TEST_ROOT }
      ).status
    ).toBe('duplicate');
  });

  it('ingestInboundEvent treats the same payload under a fresh delivery id within 24 h as a replay', () => {
    const at = new Date('2026-10-04T10:00:00.000Z');
    const first = normalizeInboundEvent({
      source: 'github',
      policy: POLICY,
      headers: { 'x-github-delivery': 'r-1', 'x-github-event': 'push' },
      body: '{"ref":"main","after":"abc"}',
      now: at,
    });
    expect(ingestInboundEvent(first, { rootDir: TEST_ROOT }).status).toBe('accepted');
    const replay = normalizeInboundEvent({
      source: 'github',
      policy: POLICY,
      headers: { 'x-github-delivery': 'r-2', 'x-github-event': 'push' },
      body: '{"ref":"main","after":"abc"}',
      now: new Date(at.getTime() + 60 * 60 * 1000),
    });
    expect(replay.payload_digest).toBe(first.payload_digest);
    expect(ingestInboundEvent(replay, { rootDir: TEST_ROOT }).status).toBe('duplicate');
    const later = normalizeInboundEvent({
      source: 'github',
      policy: POLICY,
      headers: { 'x-github-delivery': 'r-3', 'x-github-event': 'push' },
      body: '{"ref":"main","after":"abc"}',
      now: new Date(at.getTime() + 25 * 60 * 60 * 1000),
    });
    expect(ingestInboundEvent(later, { rootDir: TEST_ROOT }).status).toBe('accepted');
    const changed = normalizeInboundEvent({
      source: 'github',
      policy: POLICY,
      headers: { 'x-github-delivery': 'r-4', 'x-github-event': 'push' },
      body: '{"ref":"main","after":"def"}',
      now: new Date(at.getTime() + 60 * 60 * 1000),
    });
    expect(ingestInboundEvent(changed, { rootDir: TEST_ROOT }).status).toBe('accepted');
  });

  it('reads the ledger tail bounded and skips a torn line', () => {
    const event = normalizeInboundEvent({
      source: 'github',
      policy: POLICY,
      headers: { 'x-github-delivery': 't-1' },
      body: '{"a":1}',
    });
    ingestInboundEvent(event, { rootDir: TEST_ROOT });
    const file = `${TEST_ROOT}/${dotEventsLedgerPath()}`;
    safeAppendFileSync(file, '{"torn":\n');
    expect(DOT_EVENT_SCAN_TAIL_BYTES).toBeGreaterThan(0);
    expect(
      readDotInboundEvents(undefined, { rootDir: TEST_ROOT }).map((e) => e.delivery_id)
    ).toEqual(['t-1']);
  });
});
