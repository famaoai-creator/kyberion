import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile, safeRmSync } from '@agent/core';
import type { EventIntakePolicy } from '@agent/core/dot/dot-event-intake';
import { createEventIntakeServer, runEventIntakeSurface } from './event_intake_surface.js';
import { logger } from '@agent/core/core';

const TEST_ROOT = 'active/shared/tmp/event-intake-surface-tests';
const SECRET = 'surface-secret-0123456789abcdef';
const POLICY: EventIntakePolicy = {
  version: '1.0.0',
  sources: {
    ci: {
      enabled: true,
      signature_header: 'x-kyberion-signature',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_CI_SECRET',
      event_type_header: 'x-kyberion-event',
      delivery_id_header: 'x-kyberion-delivery',
      max_body_bytes: 256,
    },
    github: {
      enabled: false,
      signature_header: 'x-hub-signature-256',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_GITHUB_SECRET',
      event_type_header: 'x-github-event',
      delivery_id_header: 'x-github-delivery',
      max_body_bytes: 256,
    },
  },
};

let server: Server;
let baseUrl: string;
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

beforeAll(async () => {
  server = createEventIntakeServer({
    loadPolicy: () => POLICY,
    getSecret: () => SECRET,
    rootDir: TEST_ROOT,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (safeExistsSync(TEST_ROOT)) safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

function post(source: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/events/${source}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('event intake surface', () => {
  it('accepts a signed event (202) and reports the redelivery as duplicate', async () => {
    const body = JSON.stringify({ status: 'failed', secret_marker: 'BODY-MARKER' });
    const headers = {
      'x-kyberion-signature': sign(body),
      'x-kyberion-event': 'pipeline',
      'x-kyberion-delivery': 'run-1',
    };
    const info = vi.spyOn(logger, 'info');
    const first = await post('ci', body, headers);
    expect(first.status).toBe(202);
    const accepted = await first.json();
    expect(accepted).toMatchObject({ accepted: true, duplicate: false });
    const again = await post('ci', body, headers);
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ event_id: accepted.event_id, duplicate: true });
    const logged = info.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain('BODY-MARKER');
    expect(logged).not.toContain(SECRET);
    info.mockRestore();
    const ledger = String(
      safeReadFile(`${TEST_ROOT}/active/shared/runtime/dot/events.jsonl`, { encoding: 'utf8' })
    );
    expect(ledger.trim().split('\n')).toHaveLength(1);
  });

  it('rejects bad signatures, disabled and unknown sources with 401', async () => {
    const body = '{"a":1}';
    expect((await post('ci', body, { 'x-kyberion-signature': sign('{"a":2}') })).status).toBe(401);
    expect((await post('ci', body)).status).toBe(401);
    expect((await post('github', body, { 'x-hub-signature-256': sign(body) })).status).toBe(401);
    expect((await post('nope', body)).status).toBe(401);
  });

  it('answers 413 for oversize bodies, 400 for non-JSON, 404 and 405 elsewhere', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(400) });
    expect((await post('ci', big, { 'x-kyberion-signature': sign(big) })).status).toBe(413);
    expect(
      (await post('ci', 'not json', { 'x-kyberion-signature': sign('not json') })).status
    ).toBe(400);
    expect((await fetch(`${baseUrl}/nope`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${baseUrl}/events/ci/extra`, { method: 'POST', body: '{}' })).status).toBe(
      404
    );
    expect((await fetch(`${baseUrl}/events/ci`)).status).toBe(405);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it('defaults to a loopback bind and binds nothing in dry-run mode', async () => {
    process.exitCode = undefined;
    await expect(runEventIntakeSurface(['--dry-run', '--json', '--quiet'])).resolves.toMatchObject({
      dry_run: true,
      operation: 'event-intake-surface.listen',
      host: '127.0.0.1',
      port: 8791,
      enabled_sources: [],
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('is registered as an operator-launched surface on its default port', () => {
    const manifest = JSON.parse(
      String(
        safeReadFile(
          pathResolver.rootResolve(
            'knowledge/product/governance/surfaces/event-intake-surface.json'
          ),
          { encoding: 'utf8' }
        )
      )
    );
    expect(manifest.surfaces[0]).toMatchObject({
      id: 'event-intake-surface',
      port: 8791,
      enabled: false,
      healthPath: '/health',
    });
  });
});
