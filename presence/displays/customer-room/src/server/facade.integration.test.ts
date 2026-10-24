/**
 * Integration: the room's real spawner against the real built facade
 * (`dist/scripts/customer_decision.js`) on a scratch case directory. The
 * agenda is written straight into the scratch directory (the operator path
 * needs a live approval gate); the invite is issued through the real invite
 * store of a throwaway tenant. Skipped when the facade is not built.
 */
import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import {
  agendaContentHash,
  writeAgenda,
  writeAgendaAttachment,
  type AgendaAttachment,
  type DecisionAgenda,
} from '@agent/core/customer-decision';
import { DECISION_LEDGER_ROLES } from '@agent/core/decision-ledger';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExecResult,
  safeExecResultAsync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from '@agent/core/storage-layout';
import {
  createFacadeSpawner,
  FACADE_CHILD_CLEARED_ENV,
  FACADE_SCRIPT,
  facadeChildEnv,
} from './facade.js';
import { registerCustomerRoomRoutes } from './routes.js';

const BUILT = safeExistsSync(pathResolver.rootResolve(FACADE_SCRIPT));
const TENANT = 'cd-room-it';
const NOW = '2026-10-24T00:00:00.000Z';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 4, 3, 2, 1]);

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
    const brief = JSON.parse(read(`brief-input/${'agd-roomtest'}.json`)) as {
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

describe.skipIf(!BUILT)('customer-room attachments against the built facade', () => {
  // Shares nothing with the suite above except the helpers: its own case dir and tenant.
  const ATENANT = 'cd-room-att';
  let dir: string;
  let server: Server;
  let base: string;
  let token: string;
  let hash: string;
  let image: AgendaAttachment;
  const post = (route: string, body: unknown, bearer = token) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dir = pathResolver.sharedTmp(`customer-room-att-${randomUUID()}`);
    safeMkdir(dir, { recursive: true });
    const asWriter = <T>(fn: () => T): T =>
      withExecutionContext(DECISION_LEDGER_ROLES.write, fn, undefined, ATENANT);
    image = asWriter(() => writeAgendaAttachment({ dir }, 'screen.png', PNG));
    // Stored in the case but never on the agenda: the invite must not reach it.
    asWriter(() =>
      writeAgendaAttachment({ dir }, 'other.png', Buffer.concat([PNG, Buffer.from([9])]))
    );
    const agenda: DecisionAgenda = {
      version: '1.0.0',
      agenda_id: 'agd-roomatt',
      tenant_slug: ATENANT,
      case_id: 'case-att',
      customer: 'acme',
      title: 'Bolt review',
      phase: 'inception',
      revision: 1,
      locale: 'en',
      entries: [
        {
          entry_id: 'bolt_review',
          item: 'bolt:MSN-ROOM-IT',
          key: 'bolt.acceptance',
          kind: 'approval',
          question: 'Do you accept the results of this bolt?',
          our_decision: { value: { approved: true } },
          requires_customer: false,
          attachments: [image],
          links: [{ label: 'Preview', url: 'https://preview.example.com/b1' }],
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
    asWriter(() => writeAgenda({ dir }, agenda));
    const operator = (verb: string[]) =>
      JSON.parse(
        safeExecResult(
          process.execPath,
          [
            pathResolver.rootResolve(FACADE_SCRIPT),
            ...verb,
            '--tenant',
            ATENANT,
            '--case',
            agenda.case_id,
            '--dir',
            dir,
            '--json',
          ],
          {
            cwd: pathResolver.rootDir(),
            env: { ...process.env, KYBERION_TENANT: ATENANT },
            timeoutMs: 30_000,
          }
        ).stdout
      ) as Record<string, unknown>;
    operator(['actor-add', '--customer', 'acme', '--actor', 'customer:cto', '--name', 'CTO']);
    const sent = operator([
      'send',
      '--agenda',
      agenda.agenda_id,
      '--name',
      'CTO',
      '--role',
      'decider',
      '--actor',
      'customer:cto',
      '--ttl-days',
      '1',
    ]);
    token = String(sent.link).split('#t=')[1];
    const app = express();
    registerCustomerRoomRoutes(app, {
      spawner: createFacadeSpawner({ tenant: ATENANT, extraArgs: ['--dir', dir] }),
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
        `${PARTITIONED_RUNTIME_STATE_ROOTS.customer_decision_invites}/confidential/${ATENANT}`
      ),
      { recursive: true, force: true }
    );
  });

  it('lists the image and link on the item and serves exactly the stored bytes', async () => {
    const view = (await (await post('/api/view', {})).json()) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(view.entries[0]).toMatchObject({
      attachments: [{ id: image.id, name: 'screen.png', media_type: 'image/png', bytes: 13 }],
      links: [{ label: 'Preview', url: 'https://preview.example.com/b1' }],
    });
    const served = await post('/api/attachment', { attachment_id: image.id });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
  }, 30_000);

  it('answers an id that is not on the agenda like an unknown link', async () => {
    const other = createHash('sha256')
      .update(Buffer.concat([PNG, Buffer.from([9])]))
      .digest('hex');
    for (const id of [other, 'f'.repeat(64)]) {
      const response = await post('/api/attachment', { attachment_id: id });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, reason: 'invalid_link' });
    }
  }, 30_000);

  it('records a reject with its reason and refuses one without', async () => {
    const missing = await post('/api/respond', {
      content_hash: hash,
      answers: [{ entry_id: 'bolt_review', choice: 'reject' }],
    });
    expect(missing.status).toBe(422);
    const response = await post('/api/respond', {
      content_hash: hash,
      answers: [{ entry_id: 'bolt_review', choice: 'reject', comment: 'Not what we asked for' }],
    });
    expect(response.status).toBe(200);
    const view = (await (await post('/api/view', {})).json()) as {
      entries: Array<{ current: Record<string, unknown> }>;
    };
    expect(view.entries[0].current).toMatchObject({
      layer: 'customer',
      value: { approved: false, rejected: true },
    });
  }, 30_000);
});

describe('customer-room facade child env', () => {
  let scratch: string;
  beforeAll(() => {
    scratch = pathResolver.sharedTmp(`customer-room-env-${randomUUID()}`);
    safeMkdir(scratch, { recursive: true });
  });
  afterAll(() => safeRmSync(scratch, { recursive: true, force: true }));

  it('passes only the allowlist, the tenant binding and the root override — never an ambient role', async () => {
    const childEnv = facadeChildEnv('acme-corp');
    expect(childEnv.KYBERION_TENANT).toBe('acme-corp');
    expect(childEnv.KYBERION_ROOT).toBe(process.env.KYBERION_ROOT || undefined);
    for (const key of [...FACADE_CHILD_CLEARED_ENV, 'SYSTEM_ROLE']) expect(childEnv[key]).toBe('');
    // A stand-in facade that prints the env it was started with.
    const script = path.join(scratch, 'print-env.mjs');
    safeWriteFile(script, 'process.stdout.write(JSON.stringify(process.env));\n', {
      encoding: 'utf8',
    });
    const keys = [
      'SYSTEM_ROLE',
      'MISSION_ROLE',
      'KYBERION_PERSONA',
      'KYBERION_SUDO',
      'KYBERION_DELEGATED_ROLE',
      'CD_ROOM_SECRET_TEST',
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.SYSTEM_ROLE = 'customer_room';
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.KYBERION_SUDO = 'true';
    process.env.KYBERION_DELEGATED_ROLE = 'mission_controller@customer_room';
    process.env.CD_ROOM_SECRET_TEST = 'do-not-leak';
    try {
      const outcome = await createFacadeSpawner({ tenant: 'acme-corp', scriptPath: script })(
        'view',
        { token: 'x' }
      );
      const seen = JSON.parse(outcome.stdout) as Record<string, string>;
      expect(seen.KYBERION_TENANT).toBe('acme-corp');
      expect(seen.PATH).toBeTruthy();
      for (const key of keys) expect(seen[key] ?? '').toBe('');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30_000);
});

describe.skipIf(!BUILT)(
  'customer-decision respond under concurrency (built facade children)',
  () => {
    const CTENANT = 'cd-room-race';
    let dir: string;
    let hash: string;
    const deciderTokens: string[] = [];
    const facade = pathResolver.rootResolve(FACADE_SCRIPT);
    const env = { KYBERION_TENANT: CTENANT };
    const operator = (verb: string[]) =>
      JSON.parse(
        safeExecResult(
          process.execPath,
          [facade, ...verb, '--tenant', CTENANT, '--case', 'case-race', '--dir', dir, '--json'],
          { cwd: pathResolver.rootDir(), env, timeoutMs: 30_000 }
        ).stdout
      ) as Record<string, unknown>;
    const respond = (token: string, answers: unknown[]) =>
      safeExecResultAsync(
        process.execPath,
        [facade, 'respond', '--tenant', CTENANT, '--dir', dir, '--json'],
        {
          cwd: pathResolver.rootDir(),
          env,
          timeoutMs: 30_000,
          input: JSON.stringify({ token, content_hash: hash, answers }),
        }
      ).then((result) => JSON.parse(result.stdout) as Record<string, unknown>);
    const entry = (n: number) => ({
      entry_id: `q${n}`,
      item: 'NFR',
      key: `race.q${n}`,
      kind: 'choice' as const,
      question: `Question ${n}?`,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      requires_customer: false,
    });

    beforeAll(() => {
      dir = pathResolver.sharedTmp(`customer-room-race-${randomUUID()}`);
      safeMkdir(dir, { recursive: true });
      const agenda: DecisionAgenda = {
        version: '1.0.0',
        agenda_id: 'agd-racetest',
        tenant_slug: CTENANT,
        case_id: 'case-race',
        customer: 'acme',
        title: 'Race',
        phase: 'inception',
        revision: 1,
        locale: 'en',
        entries: [1, 2, 3, 4].map(entry),
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
        CTENANT
      );
      operator(['actor-add', '--customer', 'acme', '--actor', 'customer:cto', '--name', 'CTO']);
      for (let index = 0; index < 4; index += 1) {
        const sent = operator([
          'send',
          '--agenda',
          agenda.agenda_id,
          '--name',
          `Decider ${index}`,
          '--role',
          'decider',
          '--actor',
          'customer:cto',
          '--ttl-days',
          '1',
        ]);
        deciderTokens.push(String(sent.link).split('#t=')[1]);
      }
    }, 60_000);

    afterAll(() => {
      safeRmSync(dir, { recursive: true, force: true });
      safeRmSync(
        pathResolver.rootResolve(
          `${PARTITIONED_RUNTIME_STATE_ROOTS.customer_decision_invites}/confidential/${CTENANT}`
        ),
        { recursive: true, force: true }
      );
    });

    const ledgerLines = () =>
      String(safeReadFile(path.join(dir, 'decisions.jsonl'), { encoding: 'utf8' }))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id: string; key: string; value: unknown });
    const receiptFiles = () =>
      safeExistsSync(path.join(dir, 'receipts'))
        ? (safeReaddir(path.join(dir, 'receipts')) as string[]).filter((name) =>
            name.endsWith('.json')
          )
        : [];

    it('keeps every decision of concurrent responses, with unique ids and one receipt each', async () => {
      const results = await Promise.all(
        deciderTokens.map((token, index) =>
          respond(token, [{ entry_id: `q${index + 1}`, choice: 'option', value: 'b' }])
        )
      );
      expect(results.every((result) => result.ok === true)).toBe(true);
      const ledger = ledgerLines();
      // No lost decision: all four answers are in the ledger.
      expect(ledger.map((record) => record.key).sort()).toEqual([
        'race.q1',
        'race.q2',
        'race.q3',
        'race.q4',
      ]);
      expect(new Set(ledger.map((record) => record.id)).size).toBe(ledger.length);
      expect(receiptFiles()).toHaveLength(4);
      expect(
        safeExistsSync(path.join(dir, 'respond-journal'))
          ? (safeReaddir(path.join(dir, 'respond-journal')) as string[])
          : []
      ).toEqual([]);
    }, 60_000);

    it('turns a concurrent double submit into one decision and one receipt', async () => {
      const before = receiptFiles().length;
      const token = deciderTokens[0];
      const answers = [{ entry_id: 'q1', choice: 'option', value: 'a' }];
      const results = await Promise.all([
        respond(token, answers),
        respond(token, answers),
        respond(token, answers),
      ]);
      expect(results.every((result) => result.ok === true)).toBe(true);
      expect(new Set(results.map((result) => result.receipt_id)).size).toBe(1);
      expect(results.filter((result) => result.duplicate === true)).toHaveLength(2);
      expect(receiptFiles()).toHaveLength(before + 1);
      expect(
        ledgerLines().filter((record) => record.key === 'race.q1' && record.value === 'a')
      ).toHaveLength(1);
    }, 60_000);
  }
);
