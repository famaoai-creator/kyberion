/**
 * Integration: the room's real spawner against the real built facade
 * (`dist/scripts/customer_decision.js`) on a scratch case directory. The
 * agenda is written straight into the scratch directory (the operator path
 * needs a live approval gate); the invite is issued through the real invite
 * store of a throwaway tenant. Skipped when the facade is not built.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { agendaContentHash, writeAgenda, type DecisionAgenda } from '@agent/core/customer-decision';
import { DECISION_LEDGER_ROLES } from '@agent/core/decision-ledger';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
} from '@agent/core/secure-io';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from '@agent/core/storage-layout';
import { createFacadeSpawner, FACADE_SCRIPT } from './facade.js';
import { registerCustomerRoomRoutes } from './routes.js';

const BUILT = safeExistsSync(pathResolver.rootResolve(FACADE_SCRIPT));
const TENANT = 'cd-room-it';
const NOW = '2026-10-24T00:00:00.000Z';

describe.skipIf(!BUILT)('customer-room against the built facade', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let token: string;
  let deciderToken: string;
  let hash: string;

  const post = (path: string, body: unknown, bearer = token) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dir = pathResolver.sharedTmp(`customer-room-it-${randomUUID()}`);
    safeMkdir(dir, { recursive: true });
    const agenda: DecisionAgenda = {
      version: '1.0.0',
      agenda_id: 'agd-roomtest',
      tenant_slug: TENANT,
      case_id: 'case-it',
      customer: 'acme',
      title: 'Room integration',
      phase: 'inception',
      revision: 1,
      locale: 'en',
      entries: [
        {
          entry_id: 'auth.method',
          item: 'NFR',
          key: 'auth.method',
          kind: 'choice',
          question: 'Which sign-in method?',
          options: [
            { value: 'password', label: 'Password' },
            { value: 'sso', label: 'SSO', impact: { cost: '+10%' } },
          ],
          our_decision: { value: 'sso' },
          requires_customer: false,
        },
      ],
      status: 'sent',
      created_at: NOW,
      updated_at: NOW,
    };
    agenda.approval = {
      content_hash: agendaContentHash(agenda),
      approved_at: NOW,
      approved_by: 'user:alice',
    };
    hash = agenda.approval.content_hash;
    withExecutionContext(
      DECISION_LEDGER_ROLES.write,
      () => writeAgenda({ dir }, agenda),
      undefined,
      TENANT
    );
    // The operator verbs of the same built facade register the actor and print the link once.
    const operator = (verb: string[]) =>
      JSON.parse(
        safeExecResult(
          process.execPath,
          [
            pathResolver.rootResolve(FACADE_SCRIPT),
            ...verb,
            '--tenant',
            TENANT,
            '--case',
            agenda.case_id,
            '--dir',
            dir,
            '--json',
          ],
          {
            cwd: pathResolver.rootDir(),
            env: { ...process.env, KYBERION_TENANT: TENANT },
            timeoutMs: 30_000,
          }
        ).stdout
      ) as Record<string, unknown>;
    operator(['actor-add', '--customer', 'acme', '--actor', 'customer:hanako', '--name', 'Hanako']);
    const sent = operator([
      'send',
      '--agenda',
      agenda.agenda_id,
      '--name',
      'Hanako',
      '--role',
      'contributor',
      '--actor',
      'customer:hanako',
      '--ttl-days',
      '1',
    ]);
    token = String(sent.link).split('#t=')[1];
    const decider = operator([
      'send',
      '--agenda',
      agenda.agenda_id,
      '--name',
      'Hanako',
      '--role',
      'decider',
      '--actor',
      'customer:hanako',
      '--ttl-days',
      '1',
    ]);
    deciderToken = String(decider.link).split('#t=')[1];
    const app = express();
    registerCustomerRoomRoutes(app, {
      spawner: createFacadeSpawner({ tenant: TENANT, extraArgs: ['--dir', dir] }),
      staticDir: pathResolver.rootResolve('presence/displays/customer-room/static'),
      jsDir: pathResolver.rootResolve('dist/presence/displays/customer-room/src/app'),
      renderPage: () => '',
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    safeRmSync(dir, { recursive: true, force: true });
    safeRmSync(
      pathResolver.rootResolve(
        `${PARTITIONED_RUNTIME_STATE_ROOTS.customer_decision_invites}/confidential/${TENANT}`
      ),
      { recursive: true, force: true }
    );
  });

  it('shows the agenda behind a valid link without internal ids or hashes of the invite', async () => {
    const response = await post('/api/view', {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      state: 'open',
      agenda: { title: 'Room integration', locale: 'en' },
      participant: { name: 'Hanako', role: 'contributor' },
      content_hash: hash,
    });
    expect((body.entries as unknown[])[0]).toMatchObject({
      entry_id: 'auth.method',
      question: 'Which sign-in method?',
      options: [
        { label: 'Password', value: 'password' },
        { label: 'SSO', value: 'sso', impact: { cost: '+10%' } },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(token);
  }, 30_000);

  it('records a contributor opinion as a receipt', async () => {
    const response = await post('/api/respond', {
      content_hash: hash,
      answers: [{ entry_id: 'auth.method', choice: 'option', value: 'password' }],
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true });
    expect(response.status).toBe(200);
  }, 30_000);

  it('turns a decider answer into a customer decision, a switch and the brief input', async () => {
    const response = await post(
      '/api/respond',
      {
        content_hash: hash,
        answers: [{ entry_id: 'auth.method', choice: 'option', value: 'password' }],
      },
      deciderToken
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, switches: 1, change_requests: 0 });
    const view = (await (await post('/api/view', {}, deciderToken)).json()) as {
      entries: Array<{ current: Record<string, unknown> }>;
    };
    expect(view.entries[0].current).toMatchObject({
      status: 'confirmed',
      layer: 'customer',
      value: 'password',
    });
    const read = (name: string) => String(safeReadFile(path.join(dir, name), { encoding: 'utf8' }));
    const switches = read('switches.jsonl')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({
      kind: 'value_changed',
      entry_id: 'auth.method',
      to: { layer: 'customer', value: 'password' },
    });
    const brief = JSON.parse(read('brief-input.json')) as {
      decisions: Array<Record<string, unknown>>;
    };
    expect(brief.decisions[0]).toMatchObject({
      entry_id: 'auth.method',
      status: 'confirmed',
      value: 'password',
    });
  }, 30_000);

  it('answers a stale page with stale_version and a wrong link with invalid_link', async () => {
    const stale = await post('/api/respond', {
      content_hash: 'sha256:old',
      answers: [{ entry_id: 'auth.method', choice: 'keep' }],
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ ok: false, reason: 'stale_version' });
    const wrong = await post(
      '/api/view',
      {},
      'inv-0123456789abcdef.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'
    );
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toEqual({ ok: false, reason: 'invalid_link' });
  }, 30_000);
});
