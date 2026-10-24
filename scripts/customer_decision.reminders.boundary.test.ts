import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from '@agent/core/authority';
import { rootDir } from '@agent/core/path-resolver';
import * as initialIO from '@agent/core/secure-io';

/**
 * CD-11 on a fresh fixture root, through the real paths: the real case store
 * under knowledge/confidential/<tenant>/decisions/, the real invite store,
 * the real `sendToCustomer` gate (with and without a tenant charter), the
 * real surface outbox and the real operator inbox. Only the agenda approval
 * of `submit` is stubbed (it is not what this file tests) and the reasoning
 * bootstrap is disabled.
 */
const mocks = vi.hoisted(() => ({
  realGate: undefined as undefined | ((params: { operationId?: string }) => unknown),
  load: vi.fn(),
  /** When set, the outbound gate's answer (simulates a hold no human can decide). */
  outbound: undefined as undefined | Record<string, unknown>,
}));
vi.mock('@agent/core/governance/approval-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/governance/approval-gate')>();
  return {
    ...actual,
    enforceApprovalGate: (params: Parameters<typeof actual.enforceApprovalGate>[0]) =>
      params.operationId === 'customer_decision:agenda_approve'
        ? { allowed: true, status: 'approved', requestId: 'apr-agenda' }
        : params.operationId === 'customer:outbound' && mocks.outbound
          ? mocks.outbound
          : actual.enforceApprovalGate(params),
  };
});
vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-store')>()),
  loadApprovalRequest: mocks.load,
}));
vi.mock('@agent/core/reasoning/reasoning-bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/reasoning/reasoning-bootstrap')>()),
  installReasoningBackendsForService: vi.fn(() => false),
}));

const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/cd-reminders-boundary-' + process.pid);
/** No charter in force. */
const TENANT = 'cd-remind-plain';
/** A charter that delegates routine customer outbound. */
const CHARTERED = 'cd-remind-charter';
const CASE = 'case-cd';
const NOW = '2026-10-24T00:00:00.000Z';
const D_MINUS_1 = '2026-10-29T01:00:00.000Z';
const ACTOR = 'customer:acme-cto';
const UNBOUND = 'customer:acme-pm';
const TITLE = 'Secret project kickoff';
const keys = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const savedRoot = process.env.KYBERION_ROOT;

/**
 * The child-process test runs the BUILT facade. When any built file it runs is
 * missing or older than the sources it covers, it is skipped with that reason
 * (run `pnpm -s build`) instead of silently testing stale code.
 */
const DIST_FILES = [
  'dist/scripts/customer_decision.js',
  'dist/scripts/customer-decision/reminders.js',
  'libs/core/dist/customer-decision/reminders.js',
  'libs/core/dist/customer-conversation.js',
  'libs/core/dist/customer-outbound-templates.js',
  'libs/core/dist/customer-channel-binding.js',
];
const SOURCE_DIRS = ['scripts/customer-decision', 'libs/core/customer-decision'];
const SOURCE_FILES = [
  'scripts/customer_decision.ts',
  'libs/core/customer-conversation.ts',
  'libs/core/customer-outbound-templates.ts',
  'libs/core/customer-channel-binding.ts',
];
function staleDistReason(): string | null {
  const mtime = (relative: string) => {
    const file = path.join(SOURCE_ROOT, relative);
    return initialIO.safeExistsSync(file) ? initialIO.safeStat(file).mtimeMs : null;
  };
  const built = DIST_FILES.map(mtime);
  if (built.some((value) => value === null)) return 'dist/ is not built';
  const sources = [
    ...SOURCE_FILES,
    ...SOURCE_DIRS.flatMap((dir) =>
      initialIO
        .safeReaddir(path.join(SOURCE_ROOT, dir))
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => `${dir}/${name}`)
    ),
  ];
  const newestSource = Math.max(...sources.map((file) => mtime(file) ?? 0));
  const oldestBuilt = Math.min(...built.map((value) => value ?? 0));
  return newestSource > oldestBuilt ? 'dist/ is older than its sources' : null;
}
const STALE_DIST = staleDistReason();

let facade: typeof import('./customer_decision.js');
let io: typeof import('@agent/core/secure-io');

function writeFixtureJson(relative: string, value: unknown): void {
  io.safeWriteFile(path.join(ROOT, relative), `${JSON.stringify(value, null, 2)}\n`);
}

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"cd-reminders-fixture"}');
    const copy = (relative: string): void => {
      for (const name of initialIO.safeReaddir(path.join(SOURCE_ROOT, relative))) {
        const file = path.join(relative, name);
        const source = path.join(SOURCE_ROOT, file);
        const stat = initialIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(path.join(ROOT, file), initialIO.safeReadFile(source));
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
    copy('knowledge/product/orchestration');
    copy('knowledge/product/pipeline-templates');
    // The pipeline op module loads the shared project standards catalog.
    copy('knowledge/public/common');
    initialIO.safeMkdir(path.join(ROOT, 'active/shared/runtime'), { recursive: true });
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('@agent/core/secure-io');
  facade = await import('./customer_decision.js');
  expect((await import('@agent/core/path-resolver')).rootDir()).toBe(ROOT);
  process.env.KYBERION_PERSONA = 'sovereign';
  for (const tenant of [TENANT, CHARTERED]) {
    writeFixtureJson(`knowledge/personal/tenants/${tenant}.json`, {
      tenant_slug: tenant,
      display_name: tenant,
      status: 'active',
      assigned_role: 'owner',
    });
    writeFixtureJson(`customer/${tenant}/connections/channel-bindings.json`, {
      bindings: [{ surface: 'slack', channel_id: 'C-ACME', active: true }],
    });
  }
  for (const key of keys) delete process.env[key];
  mocks.load.mockReturnValue({ decidedBy: 'user:boss', decidedAt: NOW });
}, 120_000);

afterAll(() => {
  if (savedRoot === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = savedRoot;
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

type Out = Record<string, unknown>;

describe('customer-decision reminders and hand-offs (CD-11, real paths)', () => {
  const run = (argv: string[], now = NOW, stdin?: string) =>
    facade.runCustomerDecision(argv, {
      now: () => now,
      ...(stdin !== undefined ? { stdin } : {}),
    }) as Promise<Out>;
  const base = (tenant: string) => ['--tenant', tenant, '--case', CASE];
  const customer = async (verb: 'view' | 'respond', tenant: string, body: unknown, now = NOW) => {
    try {
      return { code: 0, out: await run([verb, '--tenant', tenant], now, JSON.stringify(body)) };
    } catch (error) {
      const failure = error as { code: number; returnValue: Out };
      return { code: failure.code, out: failure.returnValue };
    }
  };
  const inbox = async (filter: { tenant?: string; entryId?: string } = {}) => {
    const { listInboxEntries } = await import('@agent/core/deliverable-inbox');
    return initialContext('surface_runtime', () => listInboxEntries(filter));
  };
  const outbox = async () => {
    const { listSurfaceOutboxMessages } =
      await import('@agent/core/surface/surface-coordination-store');
    // Bridges drain every tenant namespace of the outbox.
    return initialContext('surface_runtime', () =>
      listSurfaceOutboxMessages('slack', { includeTenantNamespaces: true })
    );
  };
  const agendaFile = (tenant: string, agendaId: string) =>
    path.join(
      ROOT,
      'knowledge/confidential',
      tenant,
      'decisions',
      CASE,
      'agendas',
      `${agendaId}.json`
    );
  const readAgendaFile = (tenant: string, agendaId: string) =>
    initialContext('ecosystem_architect', () =>
      String(io.safeReadFile(agendaFile(tenant, agendaId), { encoding: 'utf8' }))
    );

  /** Draft (respond-by 2026-10-30), approve, register two deciders and send both invites. */
  const sendAgenda = async (tenant: string) => {
    const drafted = await run([
      'draft',
      ...base(tenant),
      '--customer',
      'acme',
      '--title',
      TITLE,
      '--locale',
      'en',
      '--respond-by',
      '2026-10-30',
    ]);
    expect(drafted).toMatchObject({ respond_by: '2026-10-30' });
    const agendaId = String(drafted.agenda_id);
    const file = path.join(ROOT, 'active/shared/tmp', `${tenant}-edit.json`);
    io.safeWriteFile(
      file,
      JSON.stringify({
        entries: [
          {
            entry_id: 'auth',
            item: 'NFR',
            key: 'auth.method',
            kind: 'choice',
            question: 'Which sign-in method?',
            options: [
              { value: 'password', label: 'Password' },
              { value: 'sso', label: 'SSO' },
            ],
            our_decision: { value: 'sso' },
            requires_customer: false,
          },
        ],
      })
    );
    await run(['draft', ...base(tenant), '--agenda', agendaId, '--file', file]);
    await run(['submit', ...base(tenant), '--agenda', agendaId, '--by', 'user:alice']);
    await run([
      'actor-add',
      ...base(tenant),
      '--customer',
      'acme',
      '--actor',
      ACTOR,
      '--name',
      'CTO',
      '--channel',
      'slack:C-ACME',
    ]);
    await run([
      'actor-add',
      ...base(tenant),
      '--customer',
      'acme',
      '--actor',
      UNBOUND,
      '--name',
      'PM',
    ]);
    const tokens: string[] = [];
    for (const [actor, name] of [
      [ACTOR, 'Hanako'],
      [UNBOUND, 'Taro'],
    ]) {
      const sent = await run([
        'send',
        ...base(tenant),
        '--agenda',
        agendaId,
        '--name',
        name,
        '--role',
        'decider',
        '--actor',
        actor,
      ]);
      tokens.push(String(sent.link).split('#t=')[1]);
    }
    return { agendaId, tokens };
  };

  it('refuses a channel the tenant has not bound and a respond-by in the past', async () => {
    for (const key of keys) expect(process.env[key]).toBeUndefined();
    await expect(
      run([
        'actor-add',
        ...base(TENANT),
        '--customer',
        'acme',
        '--actor',
        ACTOR,
        '--name',
        'CTO',
        '--channel',
        'slack:C-OTHER',
      ])
    ).rejects.toThrow(/not an active binding/u);
    await expect(
      run(['draft', ...base(TENANT), '--customer', 'acme', '--respond-by', '2026-10-01'])
    ).rejects.toThrow(/in the past/u);
  }, 60_000);

  let plain: { agendaId: string; tokens: string[] };

  it('dry-run writes nothing; a real run holds the reminder at the gate and hands the unbound decider to the operator', async () => {
    // Everything the approval path emits on the shared worker-event stream.
    const { getDefaultWorkerEventStream } =
      await import('@agent/core/workforce/worker-event-stream');
    const streamed: string[] = [];
    const unsubscribe = getDefaultWorkerEventStream().subscribe((event) => {
      streamed.push(JSON.stringify(event));
    });
    plain = await sendAgenda(TENANT);
    const before = readAgendaFile(TENANT, plain.agendaId);
    const inboxBefore = (await inbox()).length;
    const dry = await run(['remind', '--tenant', TENANT, '--dry-run', '--now', D_MINUS_1]);
    expect(dry).toMatchObject({
      dry_run: true,
      counts: { would_send: 1, would_remind_manually: 1 },
    });
    expect(readAgendaFile(TENANT, plain.agendaId)).toBe(before);
    expect(await inbox()).toHaveLength(inboxBefore);
    expect(await outbox()).toHaveLength(0);

    // No charter in force: the fixed template still needs a human at the gate.
    const first = await run(['remind', '--tenant', TENANT, '--now', D_MINUS_1]);
    expect(first.counts).toEqual({ approval_pending: 1, manual: 1 });
    expect(await outbox()).toHaveLength(0);
    const manual = (first.reminders as Out[]).find((item) => item.actor_id === UNBOUND) as Out;
    const entries = await inbox({ entryId: String(manual.inbox_entry_id) });
    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'customer_decision_manual_reminder',
        tenant_slug: TENANT,
      }),
    ]);
    // Ids only: the agenda title never reaches the shared inbox.
    expect(JSON.stringify(entries)).not.toContain(TITLE);

    // A real, durable request was opened for a human, scoped to the tenant.
    const held = (first.reminders as Out[]).find((item) => item.actor_id === ACTOR) as Out;
    expect(held.approval_request_id).toEqual(expect.any(String));
    const { listApprovalRequests } = await import('@agent/core/governance/approval-store');
    const requests = () =>
      initialContext('surface_runtime', () => listApprovalRequests({ storageChannels: ['slack'] }));
    const opened = requests().filter((request) => request.id === held.approval_request_id);
    expect(opened).toEqual([
      expect.objectContaining({
        status: 'pending',
        scope: expect.objectContaining({ tenant_slug: TENANT, tier: 'confidential' }),
      }),
    ]);
    // Visible to the tenant's scope only.
    const scoped = (tenant: string) =>
      initialContext('surface_runtime', () =>
        listApprovalRequests({
          storageChannels: ['slack'],
          scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant },
        })
      ).some((request) => request.id === held.approval_request_id);
    expect(scoped(TENANT)).toBe(true);
    expect(scoped(CHARTERED)).toBe(false);
    // The request title carries ids only; the message is in the scoped summary.
    expect(String(opened[0].title ?? '')).not.toContain(TITLE);

    // Same day again: the manual task is not repeated; the held reminder re-asks
    // the gate with the same correlation id (one approval request, not two).
    const second = await run(['remind', '--tenant', TENANT, '--now', D_MINUS_1]);
    expect(second.counts).toEqual({ approval_pending: 1 });
    expect((second.reminders as Out[])[0].approval_request_id).toBe(held.approval_request_id);
    expect(
      requests().filter((request) =>
        String(request.correlationId).includes(String(held.reminder_id))
      )
    ).toHaveLength(1);
    const status = await run(['status', ...base(TENANT), '--agenda', plain.agendaId], D_MINUS_1);
    expect(status.reminders).toMatchObject({
      respond_by: '2026-10-30',
      pending_approval: [expect.objectContaining({ actor_id: ACTOR, kind: 'before_due' })],
      manual: [expect.objectContaining({ actor_id: UNBOUND, reason: 'no_channel' })],
      next: expect.arrayContaining([
        expect.objectContaining({ kind: 'due', send_on: '2026-10-30' }),
      ]),
    });

    // Shared readers never see the agenda title or the message: an unscoped
    // listing of the approval store and the worker-event stream carry ids only.
    const leaks = (text: string) => text.includes(TITLE) || text.includes('Please open it');
    expect(leaks(JSON.stringify(requests()))).toBe(false);
    expect(streamed.some((line) => line.includes(String(held.approval_request_id)))).toBe(true);
    expect(streamed.some(leaks)).toBe(false);
    expect(String(opened[0].summary)).toContain(`customer-decision status --tenant ${TENANT}`);

    // An edited title is new text: a new request (the approval binds the body),
    // and the earlier pending request is cancelled, not left to pile up.
    const retitle = path.join(ROOT, 'active/shared/tmp', 'retitle.json');
    io.safeWriteFile(retitle, JSON.stringify({ title: `${TITLE} v2` }));
    await run(['draft', ...base(TENANT), '--agenda', plain.agendaId, '--file', retitle]);
    await run(['submit', ...base(TENANT), '--agenda', plain.agendaId, '--by', 'user:alice']);
    const retitled = await run(['remind', '--tenant', TENANT, '--now', D_MINUS_1]);
    expect(retitled.counts).toEqual({ approval_pending: 1 });
    const fresh = String((retitled.reminders as Out[])[0].approval_request_id);
    expect(fresh).not.toBe(held.approval_request_id);
    const byId = (id: string) => requests().find((request) => request.id === id);
    expect(byId(String(held.approval_request_id))?.status).toBe('cancelled');
    expect(byId(fresh)?.status).toBe('pending');
    expect(byId(fresh)?.accountability?.payloadHash).not.toBe(
      opened[0].accountability?.payloadHash
    );
    expect(streamed.some(leaks)).toBe(false);
    unsubscribe();
    // The rest of the file keeps the original title in its leak checks.
    const current = byId(fresh)!;

    // A human rejects it: the next run records it denied and stops asking.
    const { decideApprovalRequest } = await import('@agent/core/governance/approval-store');
    decideApprovalRequest('mission_controller', {
      channel: 'slack',
      requestId: current.id,
      decision: 'rejected',
      decidedBy: 'user:boss',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      payloadHash: current.accountability?.payloadHash,
      effectBinding: current.accountability?.effectBinding,
    });
    const third = await run(['remind', '--tenant', TENANT, '--now', D_MINUS_1]);
    expect(third.counts).toEqual({ denied: 1 });
    expect((await run(['remind', '--tenant', TENANT, '--now', D_MINUS_1])).counts).toEqual({});
    const after = await run(['status', ...base(TENANT), '--agenda', plain.agendaId], D_MINUS_1);
    expect(after.reminders).toMatchObject({
      pending_approval: [],
      denied: [expect.objectContaining({ actor_id: ACTOR, kind: 'before_due' })],
    });
  }, 120_000);

  it('a charter that delegates routine outbound sends the exact template once; an edited text still needs approval', async () => {
    const { acceptCharter } =
      await import('@agent/core/governance/accountability-charter-registry');
    const { humanActor } = await import('@agent/core/actor');
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    try {
      acceptCharter({
        draft: {
          charter_id: 'chr-remind-1',
          scope: { kind: 'organization', tenant_slug: CHARTERED },
          accountable: {
            actor: 'user:owner',
            authority_basis: { kind: 'officer', evidence_ref: 'registry-extract' },
            expires_at: '2027-12-31T00:00:00.000Z',
            deputies: [],
          },
          envelope: {
            money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
            data_tier: { read: [], write: [] },
            external_effects: { send_message_external: 'allow' },
            irreversible: 'named_actions_only',
            irreversible_named_actions: ['customer_outbound'],
            information_flow: {
              purposes: ['customer_service'],
              recipient_classes: ['bound_customer'],
              categories: ['routine_business'],
              max_attachments: 0,
            },
          },
          appetite: {
            max_loss_per_incident: 0,
            reputational_class_max: 'B',
            blast_radius_max: { recipients: 1, systems: 1 },
            tripwires: [],
          },
        },
        statement: 'I am accountable.',
        acceptedBy: humanActor('owner'),
        validation: { holder_role: 'owner' },
        now: new Date(NOW),
      });
    } finally {
      delete process.env.KYBERION_PERSONA;
      delete process.env.MISSION_ROLE;
    }
    const chartered = await sendAgenda(CHARTERED);
    const first = await run(['remind', '--tenant', CHARTERED, '--now', D_MINUS_1]);
    expect(first.counts).toEqual({ sent: 1, manual: 1 });
    const messages = (await outbox()).filter((message) =>
      String(message.correlation_id).includes(CHARTERED)
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ channel: 'C-ACME', scope: { tenant_slug: CHARTERED } });
    expect(messages[0].text).toContain(TITLE);
    expect(messages[0].text).toContain('2026-10-30');
    // Idempotent: the same day again sends nothing more.
    const again = await run(['remind', '--tenant', CHARTERED, '--now', D_MINUS_1]);
    expect(again.counts).toEqual({});
    expect(
      (await outbox()).filter((message) => String(message.correlation_id).includes(CHARTERED))
    ).toHaveLength(1);

    // The real gate with the charter: the exact template is routine; an edited body is not.
    const { sendToCustomer } = await import('@agent/core/customer-conversation');
    const { renderCustomerRoutineTemplate } =
      await import('@agent/core/customer-outbound-templates');
    const template = {
      id: 'customer_decision.reminder.due',
      params: { title: TITLE, date: '2026-10-30' },
      locale: 'en' as const,
    };
    const body = renderCustomerRoutineTemplate(template) as string;
    const binding = {
      tenantSlug: CHARTERED,
      binding: { surface: 'slack' as const, channel_id: 'C-ACME' },
    };
    const deliver = vi.fn(async () => undefined);
    // Tenant-bound, like the sweep: the gate reads the charter through its exact scope.
    const { withExecutionContextAsync } = await import('@agent/core/authority');
    const bound = <T>(fn: () => Promise<T>) =>
      withExecutionContextAsync('decision_ledger', fn, undefined, CHARTERED);
    const exact = await bound(() =>
      sendToCustomer({
        binding,
        title: 'Reminder',
        body,
        template,
        correlationId: 'cd11-gate-exact',
        nonInteractive: true,
        deliver,
      })
    );
    expect(exact.status).toBe('sent');
    const edited = await bound(() =>
      sendToCustomer({
        binding,
        title: 'Reminder',
        body: `${body} Also, here is a special offer.`,
        template,
        correlationId: 'cd11-gate-edited',
        nonInteractive: true,
        deliver,
      })
    );
    expect(edited.status).toBe('approval_pending');
    expect(deliver).toHaveBeenCalledTimes(1);
    void chartered;
  }, 120_000);

  it('hands off-option answers, comments and a general question to the real inbox (ids and counts only)', async () => {
    const token = plain.tokens[0];
    const view = await customer('view', TENANT, { token }, D_MINUS_1);
    expect(view.out).toMatchObject({ ok: true, agenda: { respond_by: '2026-10-30' } });
    const response = await customer(
      'respond',
      TENANT,
      {
        token,
        content_hash: view.out.content_hash,
        answers: [
          { entry_id: 'auth', choice: 'free_text', comment: 'passkeys please — secret-comment' },
        ],
        general_question: 'Can we talk about hosting? secret-question',
      },
      D_MINUS_1
    );
    expect(response.out).toMatchObject({ ok: true });
    const entries = (await inbox({ tenant: TENANT })).filter(
      (entry) => entry.kind === 'customer_decision_handoff'
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].entry_id).toMatch(/^INBOX-CDH-/u);
    const text = JSON.stringify(entries[0]);
    expect(text).not.toContain('secret-comment');
    expect(text).not.toContain('secret-question');
    expect(text).not.toContain(TITLE);
    const status = await run(['status', ...base(TENANT), '--agenda', plain.agendaId], D_MINUS_1);
    expect(status.handoffs).toEqual([
      expect.objectContaining({
        receipt_id: response.out.receipt_id,
        off_option: 1,
        comments: 0,
        general_question: 1,
        inbox_entry_id: entries[0].entry_id,
        notified: true,
      }),
    ]);
    expect(status.receipts).toEqual([
      expect.objectContaining({ general_question: 'Can we talk about hosting? secret-question' }),
    ]);
    // A second status adds nothing.
    await run(['status', ...base(TENANT), '--agenda', plain.agendaId], D_MINUS_1);
    expect(
      (await inbox({ tenant: TENANT })).filter(
        (entry) => entry.kind === 'customer_decision_handoff'
      )
    ).toHaveLength(1);
    const d0 = () =>
      run(['remind', '--tenant', TENANT, '--dry-run', '--now', '2026-10-30T01:00:00.000Z']);
    const remindedOn = async () =>
      ((await d0()).reminders as Out[]).map((item) => [item.actor_id, item.kind]).sort();
    // A comment-only answer and a general question are not an answer: still reminded.
    expect(await remindedOn()).toEqual([
      [ACTOR, 'due'],
      [UNBOUND, 'due'],
    ]);
    // Once the decider answers the open entry, only the unbound decider is reminded.
    const view2 = await customer('view', TENANT, { token }, D_MINUS_1);
    expect(
      (
        await customer(
          'respond',
          TENANT,
          {
            token,
            content_hash: view2.out.content_hash,
            answers: [{ entry_id: 'auth', choice: 'option', value: 'password' }],
          },
          D_MINUS_1
        )
      ).out
    ).toMatchObject({ ok: true });
    expect(await remindedOn()).toEqual([[UNBOUND, 'due']]);
  }, 120_000);

  it.skipIf(STALE_DIST !== null)(
    `the daily op runs the facade as a child bound to its tenant, and refuses another tenant${STALE_DIST ? ` (skipped: ${STALE_DIST} — run pnpm -s build)` : ''}`,
    async () => {
      const { runCustomerDecisionReminderOp, reminderFacadeEnv } =
        await import('./customer-decision/reminder-op.js');
      const { buildTenantRunEnv } = await import('./chronos_daemon.js');
      // The pipeline process: the identity a chronos tenant child runs with.
      const env = buildTenantRunEnv(TENANT);
      for (const key of [
        'KYBERION_TENANT',
        'KYBERION_TENANT_SCOPE_REQUIRED',
        'MISSION_ROLE',
        'KYBERION_PERSONA',
      ] as const)
        process.env[key] = env[key];
      process.env.SYSTEM_ROLE = 'chronos_mirror_v2';
      try {
        // The facade child never inherits a role, persona or SYSTEM_ROLE; it keeps the tenant binding.
        expect(reminderFacadeEnv(TENANT)).toMatchObject({
          SYSTEM_ROLE: '',
          MISSION_ROLE: '',
          KYBERION_PERSONA: '',
          KYBERION_TENANT: TENANT,
          KYBERION_TENANT_SCOPE_REQUIRED: '1',
          KYBERION_ROOT: ROOT,
        });
        const scriptPath = path.join(SOURCE_ROOT, 'dist/scripts/customer_decision.js');
        const at = '2026-10-30T01:00:00.000Z';
        const dry = await runCustomerDecisionReminderOp({ dryRun: true, now: at, scriptPath });
        expect(dry).toMatchObject({
          tenant: TENANT,
          dry_run: true,
          agenda_failures: 0,
          counts: { would_remind_manually: 1 },
        });
        // A real run in the child: the unbound decider's D0 inbox task.
        const real = await runCustomerDecisionReminderOp({ now: at, scriptPath });
        expect(real).toMatchObject({ agenda_failures: 0, counts: { manual: 1 } });
        expect(real.reminder_ids).toHaveLength(1);
        await expect(
          runCustomerDecisionReminderOp({ tenant: CHARTERED, now: at, scriptPath })
        ).rejects.toThrow(/TENANT_MISMATCH/u);
      } finally {
        for (const key of keys) delete process.env[key];
      }
      await expect(runCustomerDecisionReminderOp({ now: NOW })).rejects.toThrow(/TENANT_REQUIRED/u);
    },
    120_000
  );

  it('reminders --install promotes the template into the tenant pipeline catalog', async () => {
    process.env.KYBERION_PERSONA = 'sovereign';
    try {
      const out = await run(['reminders', '--tenant', TENANT, '--install']);
      expect(out).toMatchObject({
        installed: `knowledge/confidential/${TENANT}/pipelines/customer-decision-reminders.json`,
        dry_run: false,
      });
      const installed = JSON.parse(
        initialContext('ecosystem_architect', () =>
          String(io.safeReadFile(path.join(ROOT, String(out.installed)), { encoding: 'utf8' }))
        )
      ) as { steps: Array<{ op: string }>; schedule: { id: string } };
      expect(installed.steps.map((item) => item.op)).toEqual(['core:customer_decision_reminders']);
      expect(installed.schedule.id).toBe('customer-decision-reminders');
      // Chronos picks it up as a tenant pipeline of this tenant.
      const { collectTenantPipelineFiles } = await import('./chronos_daemon.js');
      expect(collectTenantPipelineFiles(ROOT)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tenant_slug: TENANT,
            file: path.join(ROOT, String(out.installed)),
          }),
        ])
      );
    } finally {
      delete process.env.KYBERION_PERSONA;
    }
  }, 60_000);

  it('warns when a channel is linked to deciders of two customers (bindings name no customer)', async () => {
    const out = await run([
      'actor-add',
      ...base(TENANT),
      '--customer',
      'globex',
      '--actor',
      'customer:globex-cto',
      '--name',
      'CTO',
      '--channel',
      'slack:C-ACME',
    ]);
    expect(out.warnings).toEqual(['channel_shared_with_customer:acme']);
    const again = await run([
      'actor-add',
      ...base(TENANT),
      '--customer',
      'globex',
      '--actor',
      'customer:globex-cto',
      '--name',
      'CTO',
      '--channel',
      'none',
    ]);
    expect(again).not.toHaveProperty('warnings');
    expect(again.actor).not.toHaveProperty('channel');
  }, 60_000);

  it('a hold that reaches no human (charter stop, no request) becomes one manual task, not a silent retry', async () => {
    mocks.outbound = { allowed: false, status: 'pending', message: '[CHARTER_STOP] tripwire' };
    try {
      const d0 = '2026-10-30T01:00:00.000Z';
      const first = await run(['remind', '--tenant', CHARTERED, '--now', d0]);
      const bound = (first.reminders as Out[]).find((item) => item.actor_id === ACTOR) as Out;
      expect(bound).toMatchObject({ kind: 'due', outcome: 'manual' });
      const entries = await inbox({ entryId: String(bound.inbox_entry_id) });
      expect(entries).toEqual([
        expect.objectContaining({ kind: 'customer_decision_manual_reminder' }),
      ]);
      expect(JSON.stringify(entries)).not.toContain(TITLE);
      expect((await run(['remind', '--tenant', CHARTERED, '--now', d0])).counts).toEqual({});
    } finally {
      mocks.outbound = undefined;
    }
  }, 60_000);
});
