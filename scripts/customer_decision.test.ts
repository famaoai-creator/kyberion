import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSpawn,
  safeWriteFile,
} from '@agent/core/secure-io';
import { ScriptExitError } from '@agent/core/script-harness';
import { readLedger } from '@agent/core/decision-ledger';
import { logger } from '@agent/core/core';
import {
  agendaContentHash,
  listAgendas,
  listReceipts,
  readAgenda,
  readSwitches,
  type AgendaEntry,
  type DecisionAgenda,
} from '@agent/core/customer-decision';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from '@agent/core/storage-layout';

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  load: vi.fn(),
  audit: vi.fn(),
  install: vi.fn(() => false),
  // Fault injection: pass through to the real store unless a test says otherwise.
  writeReceipt: vi.fn(),
  appendSwitches: vi.fn(),
  writeRespondJournal: vi.fn(),
  loadAll: vi.fn(() => [] as unknown[]),
  real: {} as {
    writeReceipt?: (...args: unknown[]) => unknown;
    appendSwitches?: (...args: unknown[]) => unknown;
    writeRespondJournal?: (...args: unknown[]) => unknown;
  },
  getDeal: vi.fn(),
  appendDealNote: vi.fn(),
  addInboxEntry: vi.fn(),
  notify: vi.fn((_event: string, _payload: unknown, _options?: unknown) => ({
    status: 'accepted' as const,
  })),
  fileBoltReviewWorkItem: vi.fn(),
  realFileBolt: undefined as undefined | ((...args: unknown[]) => unknown),
}));

vi.mock('@agent/core/governance/approval-gate', () => ({ enforceApprovalGate: mocks.gate }));
vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-store')>()),
  loadApprovalRequest: mocks.load,
}));
vi.mock('@agent/core/governance/audit-chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/governance/audit-chain')>();
  return {
    ...actual,
    auditChain: { ...actual.auditChain, record: mocks.audit, loadAll: mocks.loadAll },
  };
});
vi.mock('@agent/core/reasoning/reasoning-bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/reasoning/reasoning-bootstrap')>()),
  installReasoningBackendsForService: mocks.install,
}));
vi.mock('@agent/core/customer-decision', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/customer-decision')>();
  mocks.real.writeReceipt = actual.writeReceipt as never;
  mocks.real.appendSwitches = actual.appendSwitches as never;
  mocks.real.writeRespondJournal = actual.writeRespondJournal as never;
  return {
    ...actual,
    writeReceipt: (...args: unknown[]) => mocks.writeReceipt(...args),
    appendSwitches: (...args: unknown[]) => mocks.appendSwitches(...args),
    writeRespondJournal: (...args: unknown[]) => mocks.writeRespondJournal(...args),
  };
});
// CD-10: a rejected bolt review reaches the operator; never the real inbox in tests.
vi.mock('@agent/core/deliverable-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/deliverable-inbox')>()),
  addInboxEntry: mocks.addInboxEntry,
}));
vi.mock('@agent/core/surface/operator-notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/operator-notifications')>()),
  notifyOperatorWithReceiptSync: mocks.notify,
}));
vi.mock('@agent/core/mission/mission-bolt-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/mission/mission-bolt-review')>();
  mocks.realFileBolt = actual.fileBoltReviewWorkItem as never;
  return {
    ...actual,
    fileBoltReviewWorkItem: (...args: unknown[]) => mocks.fileBoltReviewWorkItem(...args),
  };
});
vi.mock('@agent/core/deal-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/deal-store')>()),
  getDeal: mocks.getDeal,
  appendDealNote: mocks.appendDealNote,
}));

import { parseCustomerDecisionArgs, runCustomerDecision } from './customer_decision.js';
import { tenantOf } from './customer-decision/common.js';
import { withExecutionContext } from '@agent/core/authority';

const TENANT = 'cd-facade-test';
const CASE = 'case-cd';
const NOW = '2026-10-24T00:00:00.000Z';
const ACTOR = 'customer:acme-cto';
const STORIES: AgendaEntry = {
  entry_id: 'stories',
  item: 'INCEPTION',
  key: 'user_stories',
  kind: 'approval',
  question: 'Approve these user stories?',
  our_decision: { value: ['As a sales rep I enter an order once'] },
  requires_customer: false,
};

const ENTRIES: AgendaEntry[] = [
  {
    entry_id: 'nfr.auth',
    item: 'NFR',
    key: 'auth.method',
    kind: 'choice',
    question: 'Which sign-in method?',
    background: 'Enterprise users',
    options: [
      { value: 'password', label: 'Password' },
      { value: 'sso', label: 'SSO', impact: { cost: '+10%', schedule: '+3d' } },
    ],
    our_decision: { value: 'sso', rationale: 'enterprise customers' },
    requires_customer: false,
  },
  {
    entry_id: 'nfr.locale',
    item: 'NFR',
    key: 'ui.locale',
    kind: 'choice',
    question: 'Which languages?',
    options: [
      { value: ['ja'], label: 'Japanese' },
      { value: ['ja', 'en'], label: 'Japanese + English' },
    ],
    our_decision: { value: ['ja', 'en'] },
    requires_customer: false,
  },
  {
    entry_id: 'data.retention',
    item: 'DATA',
    key: 'retention.days',
    kind: 'choice',
    question: 'How long to keep data?',
    options: [
      { value: 30, label: '30 days' },
      { value: 90, label: '90 days' },
    ],
    org_default: { value: 30, source: 'hearing:aidlc_inception' },
    requires_customer: false,
    override_until: { kind: 'date', at: '2026-10-01T00:00:00.000Z' },
  },
  {
    entry_id: 'release',
    item: 'RELEASE',
    key: 'release.go',
    kind: 'approval',
    question: 'Release to production?',
    requires_customer: true,
  },
];

/** The record of `list` (a JSON array from the facade) with this `entry_id`. */
function pick(list: unknown, entryId: string): Record<string, unknown> | undefined {
  return (list as Array<Record<string, unknown>>).find((item) => item.entry_id === entryId);
}

function inviteDir(): string {
  return pathResolver.rootResolve(
    path.posix.join(
      PARTITIONED_RUNTIME_STATE_ROOTS.customer_decision_invites,
      'confidential',
      TENANT
    )
  );
}

/**
 * CD-10: invites exist only for a registered active tenant. The registry
 * profile lives in the checkout (`knowledge/personal/tenants/<t>.json`, read
 * raw by the guard and by `isActiveCustomerTenant`); `null` removes it.
 */
function setTenantProfile(status: string | null): void {
  const file = pathResolver.rootResolve(`knowledge/personal/tenants/${TENANT}.json`);
  withExecutionContext(
    'ecosystem_architect',
    () =>
      status === null
        ? safeRmSync(file, { force: true })
        : safeWriteFile(
            file,
            JSON.stringify({
              tenant_slug: TENANT,
              display_name: 'CD facade test',
              status,
              assigned_role: 'owner',
            })
          ),
    'ecosystem_architect'
  );
}

describe('customer-decision facade', () => {
  let dir: string;
  beforeAll(() => setTenantProfile('active'));
  afterAll(() => setTenantProfile(null));
  const run = (argv: string[], stdin?: string, now = NOW) =>
    runCustomerDecision(argv, { now: () => now, ...(stdin !== undefined ? { stdin } : {}) });
  const base = () => ['--tenant', TENANT, '--case', CASE, '--dir', dir];
  const customerRun = async (verb: 'view' | 'respond', body: unknown, now = NOW) => {
    try {
      return {
        code: 0,
        out: (await run(
          [verb, '--tenant', TENANT, '--dir', dir],
          JSON.stringify(body),
          now
        )) as Record<string, unknown>,
      };
    } catch (error) {
      expect(error).toBeInstanceOf(ScriptExitError);
      return {
        code: (error as ScriptExitError).code,
        out: (error as ScriptExitError).returnValue as Record<string, unknown>,
      };
    }
  };

  beforeEach(() => {
    dir = pathResolver.sharedTmp(`customer-decision-facade-${randomUUID()}`);
    safeMkdir(dir, { recursive: true });
    mocks.gate.mockReset();
    mocks.load.mockReset();
    mocks.audit.mockReset();
    mocks.load.mockReturnValue({ decidedBy: 'user:boss', decidedAt: NOW });
    mocks.writeReceipt.mockReset();
    mocks.writeReceipt.mockImplementation((...args: unknown[]) =>
      mocks.real.writeReceipt!(...args)
    );
    mocks.appendSwitches.mockReset();
    mocks.appendSwitches.mockImplementation((...args: unknown[]) =>
      mocks.real.appendSwitches!(...args)
    );
    mocks.writeRespondJournal.mockReset();
    mocks.writeRespondJournal.mockImplementation((...args: unknown[]) =>
      mocks.real.writeRespondJournal!(...args)
    );
    mocks.loadAll.mockReset();
    mocks.loadAll.mockReturnValue([]);
    mocks.getDeal.mockReset();
    mocks.getDeal.mockReturnValue(null);
    mocks.appendDealNote.mockReset();
  });
  afterEach(() => {
    safeRmSync(dir, { recursive: true, force: true });
    safeRmSync(inviteDir(), { recursive: true, force: true });
  });

  async function draftAgenda(entries: AgendaEntry[] = ENTRIES): Promise<string> {
    const drafted = (await run([
      'draft',
      ...base(),
      '--customer',
      'acme',
      '--title',
      'Inception',
    ])) as {
      agenda_id: string;
      status: string;
    };
    expect(drafted.status).toBe('draft');
    const file = path.join(dir, 'edit.json');
    safeWriteFile(file, JSON.stringify({ entries }), { encoding: 'utf8' });
    await run(['draft', ...base(), '--agenda', drafted.agenda_id, '--file', file]);
    return drafted.agenda_id;
  }

  function approveNext(requestId = 'apr-1') {
    mocks.gate.mockReturnValueOnce({ allowed: true, status: 'approved', requestId });
  }

  async function approvedAndSent(role: 'decider' | 'contributor' = 'decider') {
    const agendaId = await draftAgenda();
    approveNext();
    await run(['submit', ...base(), '--agenda', agendaId, '--by', 'user:alice']);
    await run(['actor-add', ...base(), '--customer', 'acme', '--actor', ACTOR, '--name', 'CTO']);
    const sent = (await run([
      'send',
      ...base(),
      '--agenda',
      agendaId,
      '--name',
      'Hanako',
      '--role',
      role,
      '--actor',
      ACTOR,
    ])) as { link: string; invite_id: string };
    const token = sent.link.split('#t=')[1];
    return { agendaId, token, inviteId: sent.invite_id };
  }

  const agendaOf = (agendaId: string) => readAgenda({ dir }, agendaId) as DecisionAgenda;

  it('parses verbs and options', () => {
    expect(parseCustomerDecisionArgs(['send', '--tenant', 't', '--json'])).toEqual({
      verb: 'send',
      opts: { tenant: 't' },
      flags: new Set(['json']),
      lists: { tenant: ['t'] },
    });
    // A repeated option keeps every value in order (bolt-review --attach).
    expect(
      parseCustomerDecisionArgs(['bolt-review', '--attach', 'a.png', '--attach', 'b.png']).lists
    ).toEqual({ attach: ['a.png', 'b.png'] });
  });

  it('sets, edits and clears respond_by; on a sent agenda a new date is a new revision (CD-11)', async () => {
    const { agendaId, token } = await approvedAndSent();
    const sentHash = agendaContentHash(agendaOf(agendaId));
    const edited = (await run([
      'draft',
      ...base(),
      '--agenda',
      agendaId,
      '--respond-by',
      '2026-10-30',
    ])) as Record<string, unknown>;
    expect(edited).toMatchObject({ respond_by: '2026-10-30', revision: 2, status: 'draft' });
    expect(edited.content_hash).not.toBe(sentHash);
    // The customer sees the agenda as updating until the new date is approved.
    expect((await customerRun('view', { token })).out).toMatchObject({ state: 'updating' });
    approveNext('apr-2');
    await run(['submit', ...base(), '--agenda', agendaId, '--by', 'user:alice']);
    expect((await customerRun('view', { token })).out).toMatchObject({
      state: 'open',
      agenda: { respond_by: '2026-10-30' },
    });
    // --file keeps the date unless the file names one; none clears it.
    const file = path.join(dir, 'keep.json');
    safeWriteFile(file, JSON.stringify({ title: 'Inception v2' }), { encoding: 'utf8' });
    await run(['draft', ...base(), '--agenda', agendaId, '--file', file]);
    expect(agendaOf(agendaId).respond_by).toBe('2026-10-30');
    await run(['draft', ...base(), '--agenda', agendaId, '--respond-by', 'none']);
    expect(agendaOf(agendaId)).not.toHaveProperty('respond_by');
    await expect(
      run(['draft', ...base(), '--agenda', agendaId, '--respond-by', '2026-02-30'])
    ).rejects.toThrow(/YYYY-MM-DD/u);
  });

  it('drafts from the template, then edits the draft in place', async () => {
    const drafted = (await run(['draft', ...base(), '--customer', 'acme'])) as {
      agenda_id: string;
      revision: number;
      entries: number;
    };
    expect(drafted.revision).toBe(1);
    expect(drafted.entries).toBeGreaterThan(0);
    const file = path.join(dir, 'edit.json');
    safeWriteFile(
      file,
      JSON.stringify({
        title: 'Edited',
        entries: [{ ...ENTRIES[0], our_decision: { value: 'sso', decision_id: 'D-9999' } }],
      }),
      { encoding: 'utf8' }
    );
    const edited = (await run([
      'draft',
      ...base(),
      '--agenda',
      drafted.agenda_id,
      '--file',
      file,
    ])) as {
      revision: number;
      status: string;
    };
    expect(edited).toMatchObject({ revision: 1, status: 'draft' });
    const agenda = agendaOf(drafted.agenda_id);
    expect(agenda.title).toBe('Edited');
    // A pinned decision id can never be smuggled in through an edit.
    expect(agenda.entries[0].our_decision).toEqual({ value: 'sso' });
  });

  it('generates our draft decisions into a draft only', async () => {
    const drafted = (await run(['draft', ...base(), '--customer', 'acme'])) as {
      agenda_id: string;
    };
    const intent = path.join(dir, 'intent.md');
    safeWriteFile(intent, 'Cut the manual order entry for the sales team.', { encoding: 'utf8' });
    const generated = (await run([
      'generate',
      ...base(),
      '--agenda',
      drafted.agenda_id,
      '--intent-file',
      intent,
    ])) as Record<string, unknown>;
    expect(generated).toMatchObject({ status: 'draft', agenda_id: drafted.agenda_id });
    expect(Array.isArray(generated.notes)).toBe(true);
    expect(mocks.install).toHaveBeenCalled();
    const agenda = agendaOf(drafted.agenda_id);
    expect(agenda.status).toBe('draft');

    // Without inference the approval drafts stay empty; replace the entries to submit.
    const file = path.join(dir, 'edit.json');
    safeWriteFile(file, JSON.stringify({ entries: ENTRIES }), { encoding: 'utf8' });
    await run(['draft', ...base(), '--agenda', drafted.agenda_id, '--file', file]);
    approveNext();
    await run(['submit', ...base(), '--agenda', drafted.agenda_id, '--by', 'user:alice']);
    await expect(
      run(['generate', ...base(), '--agenda', drafted.agenda_id, '--intent-file', intent])
    ).rejects.toThrow(/generate only fills a draft/u);
  });

  it('refuses to submit entries the customer cannot answer, listing them', async () => {
    const { our_decision: _ours, ...storiesWithoutDraft } = STORIES;
    void _ours;
    const agendaId = await draftAgenda([
      ENTRIES[0],
      // A requires_customer approval (the schema forbids ours on it) asks the question itself.
      ENTRIES[3],
      storiesWithoutDraft,
      {
        entry_id: 'mvp',
        item: 'MVP',
        key: 'mvp.order',
        kind: 'ranking',
        question: 'Which first?',
        requires_customer: false,
      },
    ]);
    await expect(
      run(['submit', ...base(), '--agenda', agendaId, '--by', 'user:alice'])
    ).rejects.toThrow(
      /cannot answer: stories \(approval: no draft in our_decision.value\), mvp \(ranking: no options\)/u
    );
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(agendaOf(agendaId).status).toBe('draft');
  });

  it('sets who the request is from at draft and on edit, and shows it to the customer', async () => {
    const drafted = (await run([
      'draft',
      ...base(),
      '--customer',
      'acme',
      '--title',
      'Inception',
      '--from',
      'Example Systems',
    ])) as { agenda_id: string; content_hash: string; from: string };
    expect(drafted.from).toBe('Example Systems');
    expect(agendaOf(drafted.agenda_id).from).toBe('Example Systems');
    const file = path.join(dir, 'edit.json');
    safeWriteFile(
      file,
      JSON.stringify({ from: 'Example Systems / Sales', entries: [...ENTRIES, STORIES] }),
      { encoding: 'utf8' }
    );
    const edited = (await run([
      'draft',
      ...base(),
      '--agenda',
      drafted.agenda_id,
      '--file',
      file,
    ])) as { content_hash: string };
    expect(agendaOf(drafted.agenda_id).from).toBe('Example Systems / Sales');
    // The sender is part of what the customer is shown, so it is in the content hash.
    const { from: _from, ...withoutFrom } = agendaOf(drafted.agenda_id);
    void _from;
    expect(agendaContentHash(withoutFrom)).not.toBe(edited.content_hash);
    approveNext();
    await run(['submit', ...base(), '--agenda', drafted.agenda_id, '--by', 'user:alice']);
    await run(['actor-add', ...base(), '--customer', 'acme', '--actor', ACTOR, '--name', 'CTO']);
    const sent = (await run([
      'send',
      ...base(),
      '--agenda',
      drafted.agenda_id,
      '--name',
      'Hanako',
      '--role',
      'decider',
      '--actor',
      ACTOR,
    ])) as { link: string };
    const view = await customerRun('view', { token: sent.link.split('#t=')[1] });
    expect(view.out.agenda).toMatchObject({ title: 'Inception', from: 'Example Systems / Sales' });
    // An approval entry shows the draft being approved; a requires_customer one has none.
    expect(pick(view.out.entries, 'stories')).toMatchObject({
      kind: 'approval',
      draft: ['As a sales rep I enter an order once'],
    });
    expect(pick(view.out.entries, 'release')).not.toHaveProperty('draft');
  });

  it('submit waits for the approval gate, then pins our decisions', async () => {
    const agendaId = await draftAgenda();
    mocks.gate.mockReturnValueOnce({
      allowed: false,
      status: 'pending',
      requestId: 'apr-7',
      requestStatus: 'created',
    });
    const pending = (await run([
      'submit',
      ...base(),
      '--agenda',
      agendaId,
      '--by',
      'user:alice',
    ])) as Record<string, unknown>;
    expect(pending).toMatchObject({
      status: 'pending_approval',
      approval_request_id: 'apr-7',
      next: expect.stringContaining('pnpm kyberion approvals --approve apr-7'),
    });
    const hash = agendaContentHash(agendaOf(agendaId));
    expect(mocks.gate).toHaveBeenCalledWith(
      expect.objectContaining({
        requireApproval: true,
        operationId: 'customer_decision:agenda_approve',
        correlationId: `${TENANT}:${agendaId}:${hash}`,
        payload: expect.objectContaining({ tenant: TENANT, agenda_id: agendaId }),
        requestScope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: TENANT },
        draft: expect.objectContaining({
          summary: expect.stringContaining('customer-decision status --tenant'),
        }),
      })
    );
    // The shared approval store gets ids only: no title, question or decision of ours.
    const submitDraft = JSON.stringify(mocks.gate.mock.calls.at(-1)?.[0]?.draft);
    expect(submitDraft).not.toMatch(/Inception|sign-in|"sso"|sso|Release to production/u);
    expect(agendaOf(agendaId).status).toBe('pending_approval');
    expect(readLedger({ dir })).toEqual([]);

    approveNext('apr-7');
    const approved = (await run([
      'submit',
      ...base(),
      '--agenda',
      agendaId,
      '--by',
      'user:alice',
    ])) as Record<string, unknown>;
    // approved_by is the approval's decider; --by is only the unverified submitter.
    expect(approved).toMatchObject({
      status: 'approved',
      approved_by: 'user:boss',
      submitted_by: 'user:alice',
    });
    const ledger = readLedger({ dir });
    expect(ledger.map((record) => [record.key, record.state, record.value])).toEqual([
      ['auth.method', 'proposed', 'sso'],
      ['ui.locale', 'proposed', ['ja', 'en']],
    ]);
    expect(ledger[0]).toMatchObject({
      level: 'customer-value',
      origin: 'facade',
      proposed_by: { kind: 'human', id: 'user:alice' },
      basis: [{ ref: `agenda:${agendaId}`, version: hash }],
    });
    const agenda = agendaOf(agendaId);
    expect(agenda.approval).toMatchObject({
      content_hash: hash,
      request_id: 'apr-7',
      approved_by: 'user:boss',
      submitted_by: 'user:alice',
    });
    expect(agendaContentHash(agenda)).toBe(hash);
    expect(agenda.entries[0].our_decision?.decision_id).toBe('D-0001');

    // Re-running after approval is a no-op.
    const again = (await run([
      'submit',
      ...base(),
      '--agenda',
      agendaId,
      '--by',
      'user:alice',
    ])) as Record<string, unknown>;
    expect(again.already_approved).toBe(true);
    expect(readLedger({ dir })).toHaveLength(2);
  });

  it('pins nothing when the allowed approval names no decider (never falls back to --by)', async () => {
    const agendaId = await draftAgenda();
    approveNext('apr-nodecider');
    mocks.load.mockReturnValueOnce({ decidedAt: NOW });
    const failure = await run([
      'submit',
      ...base(),
      '--agenda',
      agendaId,
      '--by',
      'user:alice',
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScriptExitError);
    expect((failure as ScriptExitError).code).toBe(1);
    expect(String((failure as Error).message)).toMatch(/names no decider/u);
    expect(agendaOf(agendaId).approval).toBeUndefined();
    expect(agendaOf(agendaId).status).not.toBe('approved');
    expect(readLedger({ dir })).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'agenda_approve' })
    );
  });

  it('refuses to send an unapproved agenda or to an unregistered actor', async () => {
    const agendaId = await draftAgenda();
    await expect(
      run([
        'send',
        ...base(),
        '--agenda',
        agendaId,
        '--name',
        'H',
        '--role',
        'decider',
        '--actor',
        ACTOR,
      ])
    ).rejects.toThrow(/not approved/u);
    approveNext();
    await run(['submit', ...base(), '--agenda', agendaId, '--by', 'user:alice']);
    await expect(
      run([
        'send',
        ...base(),
        '--agenda',
        agendaId,
        '--name',
        'H',
        '--role',
        'decider',
        '--actor',
        ACTOR,
      ])
    ).rejects.toThrow(/not registered/u);
  });

  it('sends a link once, views and responds as a decider', async () => {
    const { agendaId, token, inviteId } = await approvedAndSent();
    expect(agendaOf(agendaId).status).toBe('sent');
    expect(token).toMatch(/^inv-[a-f0-9]{16}\./u);
    // The token never reaches the audit chain.
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(token.split('.')[1]);

    const view = await customerRun('view', { token });
    expect(view.code).toBe(0);
    expect(view.out).toMatchObject({
      ok: true,
      state: 'open',
      agenda: { title: 'Inception', locale: 'ja' },
      participant: { name: 'Hanako', role: 'decider' },
      content_hash: agendaContentHash(agendaOf(agendaId)),
    });
    const entries = view.out.entries as Array<Record<string, unknown>>;
    expect(entries.find((entry) => entry.entry_id === 'nfr.auth')).toEqual({
      entry_id: 'nfr.auth',
      kind: 'choice',
      question: 'Which sign-in method?',
      background: 'Enterprise users',
      options: [
        { label: 'Password', value: 'password' },
        { label: 'SSO', value: 'sso', impact: { cost: '+10%', schedule: '+3d' } },
      ],
      requires_customer: false,
      current: {
        status: 'provisional',
        layer: 'ours',
        value: 'sso',
        awaiting_operator_confirmation: false,
      },
      overridable: true,
    });
    expect(entries.find((entry) => entry.entry_id === 'release')?.current).toEqual({
      status: 'awaiting_customer',
      layer: 'none',
      awaiting_operator_confirmation: false,
    });
    // No internal fields leak into the customer projection.
    expect(JSON.stringify(view.out)).not.toMatch(
      /rationale|decision_id|enterprise customers|D-000/u
    );

    const body = {
      token,
      content_hash: view.out.content_hash,
      answers: [
        { entry_id: 'nfr.auth', choice: 'option', value: 'password', comment: 'SSO later' },
        { entry_id: 'nfr.locale', choice: 'keep' },
        { entry_id: 'data.retention', choice: 'option', value: 90 },
      ],
    };
    const response = await customerRun('respond', body);
    expect(response).toEqual({
      code: 0,
      out: {
        ok: true,
        receipt_id: expect.stringMatching(/^rcp-/u),
        switches: 2,
        change_requests: 1,
      },
    });
    // Each receipt answer records what it did.
    expect(
      listReceipts({ dir })[0].answers.map((answer) => [answer.entry_id, answer.outcome])
    ).toEqual([
      ['nfr.auth', 'decided'],
      ['nfr.locale', 'decided'],
      ['data.retention', 'change_request'],
    ]);
    const ledger = readLedger({ dir });
    const decided = ledger.filter((record) => record.state === 'decided');
    expect(decided.map((record) => [record.key, record.value, record.supersedes])).toEqual([
      ['auth.method', 'password', 'D-0001'],
      ['ui.locale', ['ja', 'en'], 'D-0002'],
    ]);
    expect(decided[0].decided_by).toEqual({
      kind: 'human',
      id: `user:${inviteId}`,
      display_name: 'Hanako',
      on_behalf_of: { actor_id: ACTOR, evidence: response.out.receipt_id },
    });
    const switches = readSwitches({ dir });
    expect(
      switches.map((item) => [item.entry_id, item.kind, item.from.layer, item.to.layer])
    ).toEqual([
      ['nfr.auth', 'value_changed', 'ours', 'customer'],
      ['nfr.locale', 'confirmed', 'ours', 'customer'],
    ]);
    const brief = JSON.parse(
      String(safeReadFile(path.join(dir, 'brief-input', `${agendaId}.json`), { encoding: 'utf8' }))
    );
    expect(pick(brief.decisions, 'nfr.auth')).toMatchObject({
      value: 'password',
      status: 'confirmed',
      layer: 'customer',
    });

    // Double submit: nothing new in the ledger, the same receipt comes back.
    const again = await customerRun('respond', body);
    expect(again.out).toMatchObject({
      ok: true,
      receipt_id: response.out.receipt_id,
      duplicate: true,
    });
    expect(readLedger({ dir })).toHaveLength(ledger.length);

    const status = (await run(['status', ...base(), '--agenda', agendaId])) as Record<
      string,
      unknown
    >;
    expect(status.change_requests).toEqual([
      expect.objectContaining({ entry_id: 'data.retention', value: 90 }),
    ]);
    expect(status.invites).toEqual([expect.objectContaining({ invite_id: inviteId, uses: 3 })]);
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(status.receipts).toHaveLength(1);
    expect(status.switches).toHaveLength(2);
    expect(pick(status.effective, 'data.retention')).toMatchObject({
      layer: 'org_default',
      value: 30,
      overridable: false,
    });
  });

  it('keeps a requires_customer entry awaiting until the decider decides, then until the operator confirms', async () => {
    const { agendaId, token } = await approvedAndSent();
    const view = await customerRun('view', { token });
    const confirmArgs = ['confirm', ...base(), '--agenda', agendaId, '--entry', 'release'];
    // Nothing to confirm before the customer decided.
    await expect(run([...confirmArgs, '--by', 'user:alice'])).rejects.toThrow(
      /no customer decision to confirm/u
    );
    // Only requires_customer entries take an operator confirmation.
    await expect(
      run(['confirm', ...base(), '--agenda', agendaId, '--entry', 'nfr.auth', '--by', 'user:alice'])
    ).rejects.toThrow(/not requires_customer/u);
    const response = await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'release', choice: 'approve' }],
    });
    expect(response.out).toMatchObject({ ok: true, switches: 1 });
    // Money / contract: the customer's decision is provisional until the operator confirms it.
    const after = await customerRun('view', { token });
    expect(pick(after.out.entries, 'release')?.current).toEqual({
      status: 'provisional',
      layer: 'customer',
      value: { approved: true },
      awaiting_operator_confirmation: true,
    });
    expect(after.out.receipts).toHaveLength(1);
    const decisionId = readLedger({ dir }).find((record) => record.key === 'release.go')?.id;
    const status = (await run(['status', ...base(), '--agenda', agendaId])) as Record<
      string,
      unknown
    >;
    expect(status.awaiting_confirmation).toEqual([
      expect.objectContaining({
        entry_id: 'release',
        decision_id: decisionId,
        next: expect.stringContaining('customer-decision confirm'),
      }),
    ]);
    expect(pick(status.effective, 'release')).toMatchObject({
      layer: 'customer',
      status: 'provisional',
      awaiting_operator_confirmation: true,
    });

    await expect(run(confirmArgs)).rejects.toThrow(/--by user:<member> is required/u);
    const hashBefore = agendaContentHash(agendaOf(agendaId));
    // --by alone is not the authority: the approval gate decides.
    mocks.gate.mockReturnValueOnce({
      allowed: false,
      status: 'pending',
      requestId: 'apr-c1',
      requestStatus: 'created',
    });
    const pending = (await run([...confirmArgs, '--by', 'user:alice'])) as Record<string, unknown>;
    expect(pending).toMatchObject({
      entry_id: 'release',
      decision_id: decisionId,
      approval_request_id: 'apr-c1',
      status: 'provisional',
      next: expect.stringContaining('pnpm kyberion approvals --approve apr-c1'),
    });
    expect(mocks.gate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requireApproval: true,
        operationId: 'customer_decision:operator_confirm',
        correlationId: `${TENANT}:${agendaId}:release:${decisionId}`,
        payload: expect.objectContaining({ tenant: TENANT, decision_id: decisionId }),
        requestScope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: TENANT },
      })
    );
    // Ids only in the shared approval store; --by is shown as unverified.
    const confirmDraft = JSON.stringify(mocks.gate.mock.calls.at(-1)?.[0]?.draft);
    expect(confirmDraft).not.toMatch(/Release to production|approved/u);
    expect(confirmDraft).toContain('Requested as user:alice (unverified)');
    expect(agendaOf(agendaId).operator_confirmations ?? []).toEqual([]);
    mocks.gate.mockReturnValueOnce({
      allowed: false,
      status: 'denied',
      requestId: 'apr-c1',
      requestStatus: 'rejected',
    });
    await expect(run([...confirmArgs, '--by', 'user:alice'])).rejects.toBeInstanceOf(
      ScriptExitError
    );
    expect(agendaOf(agendaId).operator_confirmations ?? []).toEqual([]);
    approveNext('apr-c2');
    const confirmed = (await run([...confirmArgs, '--by', 'user:alice'])) as Record<
      string,
      unknown
    >;
    expect(confirmed).toMatchObject({
      entry_id: 'release',
      decision_id: decisionId,
      // Who confirmed is the approval's decider, not the unverified --by.
      confirmed_by: 'user:boss',
      requested_by: 'user:alice',
      approval_request_id: 'apr-c2',
      status: 'confirmed',
      already_confirmed: false,
      switches: 1,
    });
    const agenda = agendaOf(agendaId);
    expect(agenda.operator_confirmations).toEqual([
      {
        entry_id: 'release',
        decision_id: decisionId,
        by: 'user:boss',
        requested_by: 'user:alice',
        at: NOW,
        request_id: 'apr-c2',
      },
    ]);
    // The ledger record stays the customer's `decided` record; confirmation lives on the agenda.
    expect(readLedger({ dir }).find((record) => record.id === decisionId)).toMatchObject({
      state: 'decided',
      status: 'active',
    });
    // The confirmation leaves the approved content (and so the customer's link) intact.
    expect(agendaContentHash(agenda)).toBe(hashBefore);
    expect((await customerRun('view', { token })).out.state).toBe('open');
    expect(pick((await customerRun('view', { token })).out.entries, 'release')?.current).toEqual({
      status: 'confirmed',
      layer: 'customer',
      value: { approved: true },
      awaiting_operator_confirmation: false,
    });
    expect(readSwitches({ dir }).at(-1)).toMatchObject({
      kind: 'confirmed',
      entry_id: 'release',
      from: { layer: 'customer', decision_id: decisionId },
      to: { layer: 'customer', decision_id: decisionId },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'operator_confirm',
        metadata: expect.objectContaining({
          decision_id: decisionId,
          confirmed_by: 'user:boss',
          requested_by: 'user:alice',
        }),
      })
    );
    const gateCalls = mocks.gate.mock.calls.length;
    // Re-run as someone else: the original confirmer stays, no new identity is recorded.
    const again = (await run([...confirmArgs, '--by', 'user:mallory'])) as Record<string, unknown>;
    expect(again).toMatchObject({
      already_confirmed: true,
      switches: 0,
      confirmed_by: 'user:boss',
      requested_by: 'user:mallory',
    });
    expect(agendaOf(agendaId).operator_confirmations?.[0]).toMatchObject({ by: 'user:boss' });
    // Re-confirming the same decision writes nothing new and asks no approval.
    expect(mocks.gate.mock.calls.length).toBe(gateCalls);
    expect(agendaOf(agendaId).operator_confirmations).toHaveLength(1);
    const after2 = (await run(['status', ...base(), '--agenda', agendaId])) as Record<
      string,
      unknown
    >;
    expect(after2.awaiting_confirmation).toEqual([]);
  });

  it('records a contributor answer without touching the ledger', async () => {
    const { token } = await approvedAndSent('contributor');
    const before = readLedger({ dir }).length;
    const view = await customerRun('view', { token });
    const response = await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
    });
    expect(response.out).toMatchObject({ ok: true, switches: 0, change_requests: 0 });
    expect(readLedger({ dir })).toHaveLength(before);
  });

  it('maps bad links, tampered hashes and revoked or expired invites to reason codes', async () => {
    const { agendaId, token, inviteId } = await approvedAndSent();
    expect(await customerRun('view', { token: 'nope' })).toEqual({
      code: 1,
      out: { ok: false, reason: 'invalid_link' },
    });
    expect(await customerRun('view', { token: `${inviteId}.${'A'.repeat(43)}` })).toEqual({
      code: 1,
      out: { ok: false, reason: 'invalid_link' },
    });
    const malformed = await run(['view', '--tenant', TENANT, '--dir', dir], 'not json').catch(
      (error: ScriptExitError) => error.returnValue
    );
    expect(malformed).toEqual({ ok: false, reason: 'invalid_request' });
    expect(
      await customerRun('respond', {
        token,
        content_hash: 'f'.repeat(64),
        answers: [{ entry_id: 'nfr.auth', choice: 'keep' }],
      })
    ).toEqual({ code: 1, out: { ok: false, reason: 'stale_version' } });
    expect(
      await customerRun('respond', {
        token,
        content_hash: agendaContentHash(agendaOf(agendaId)),
        answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'magic' }],
      })
    ).toEqual({
      code: 1,
      out: {
        ok: false,
        reason: 'invalid_answers',
        errors: [{ entry_id: 'nfr.auth', error: 'option_not_offered' }],
      },
    });
    expect((await customerRun('view', { token }, '2026-12-01T00:00:00.000Z')).out).toEqual({
      ok: false,
      reason: 'expired',
    });
    await run(['revoke', ...base(), '--invite', inviteId, '--reason', 'wrong person']);
    expect((await customerRun('view', { token })).out).toEqual({ ok: false, reason: 'revoked' });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'invite_revoke',
        metadata: expect.objectContaining({ invite_id: inviteId }),
      })
    );
  });

  describe('a tenant that is not registered and active (CD-10)', () => {
    afterEach(() => setTenantProfile('active'));

    it('send refuses it before anything is issued', async () => {
      const agendaId = await draftAgenda();
      approveNext();
      await run(['submit', ...base(), '--agenda', agendaId, '--by', 'user:alice']);
      await run(['actor-add', ...base(), '--customer', 'acme', '--actor', ACTOR, '--name', 'CTO']);
      for (const status of ['suspended', null]) {
        setTenantProfile(status);
        const refused = await run([
          'send',
          ...base(),
          '--agenda',
          agendaId,
          '--name',
          'Hanako',
          '--role',
          'decider',
          '--actor',
          ACTOR,
        ]).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(ScriptExitError);
        expect((refused as ScriptExitError).code).toBe(2);
        expect((refused as ScriptExitError).message).toContain('[CD_INVITE_TENANT_NOT_REGISTERED]');
      }
      expect(safeExistsSync(inviteDir())).toBe(false);
      expect(agendaOf(agendaId).status).not.toBe('sent');
      expect(mocks.audit).not.toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'invite_issue' })
      );
    });

    it('the customer room answers unavailable; the operator can still revoke', async () => {
      const { token, inviteId } = await approvedAndSent();
      setTenantProfile('suspended');
      mocks.audit.mockClear();
      for (const verb of ['view', 'respond'] as const)
        expect(await customerRun(verb, { token })).toEqual({
          code: 1,
          out: { ok: false, reason: 'unavailable' },
        });
      // The audit trace carries ids only: never the token or its secret.
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'invite_view',
          result: 'failed',
          reason: 'CD_INVITE_TENANT_NOT_REGISTERED',
          metadata: { invite_id: inviteId, diagnostic_code: 'CD_INVITE_TENANT_NOT_REGISTERED' },
        })
      );
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(token);
      // A malformed token answers invalid_link exactly as for an active tenant
      // (the answer never reveals the registration state), and is not audited.
      mocks.audit.mockClear();
      for (const bad of ['nope', `${inviteId}.short`, `${inviteId}`]) {
        expect(await customerRun('view', { token: bad })).toEqual({
          code: 1,
          out: { ok: false, reason: 'invalid_link' },
        });
      }
      expect(mocks.audit).not.toHaveBeenCalled();
      const revoked = (await run([
        'revoke',
        ...base(),
        '--invite',
        inviteId,
        '--reason',
        'tenant suspended',
      ])) as Record<string, unknown>;
      expect(revoked).toMatchObject({ invite_id: inviteId });
      // Reactivated: the revoke stands.
      setTenantProfile('active');
      expect((await customerRun('view', { token })).out).toEqual({
        ok: false,
        reason: 'revoked',
      });
    });
  });

  it('shows updating after an edit and never lets ours supersede a customer decision', async () => {
    const { agendaId, token } = await approvedAndSent();
    const view = await customerRun('view', { token });
    await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
    });
    const customerDecision = readLedger({ dir }).find((record) => record.state === 'decided');
    expect(customerDecision).toBeDefined();

    // Edit after sending: a new revision, the customer sees "updating".
    const file = path.join(dir, 'edit2.json');
    const entries = ENTRIES.map((entry) =>
      entry.entry_id === 'nfr.locale' ? { ...entry, our_decision: { value: ['ja'] } } : entry
    );
    safeWriteFile(file, JSON.stringify({ entries }), { encoding: 'utf8' });
    const edited = (await run([
      'draft',
      ...base(),
      '--agenda',
      agendaId,
      '--file',
      file,
    ])) as Record<string, unknown>;
    expect(edited).toMatchObject({ revision: 2, status: 'draft' });
    expect((await customerRun('view', { token })).out).toEqual({
      ok: true,
      state: 'updating',
      participant: { name: 'Hanako', role: 'decider' },
    });
    // An answer to the old revision is not carried over.
    expect(
      (
        await customerRun('respond', {
          token,
          content_hash: view.out.content_hash,
          answers: [{ entry_id: 'nfr.locale', choice: 'keep' }],
        })
      ).out
    ).toEqual({ ok: false, reason: 'updating' });

    approveNext('apr-2');
    const reapproved = (await run([
      'submit',
      ...base(),
      '--agenda',
      agendaId,
      '--by',
      'user:alice',
    ])) as Record<string, unknown>;
    expect(reapproved.skipped).toEqual([
      { entry_id: 'nfr.auth', reason: 'customer_decided', decision_id: customerDecision?.id },
    ]);
    const active = readLedger({ dir }).filter((record) => record.status === 'active');
    expect(active.find((record) => record.key === 'auth.method')).toMatchObject({
      id: customerDecision?.id,
      state: 'decided',
      value: 'password',
    });
    expect(active.find((record) => record.key === 'ui.locale')).toMatchObject({
      state: 'proposed',
      value: ['ja'],
    });
    const after = await customerRun('view', { token });
    expect(after.out.state).toBe('open');
    expect(pick(after.out.entries, 'nfr.auth')?.current).toEqual({
      status: 'confirmed',
      layer: 'customer',
      value: 'password',
      awaiting_operator_confirmation: false,
    });
  });
  it('keeps the approved decisions in force while an edit awaits re-approval', async () => {
    const { agendaId, token } = await approvedAndSent();
    const before = (await run(['status', ...base(), '--agenda', agendaId])) as Record<
      string,
      unknown
    >;
    expect(pick(before.effective, 'nfr.auth')).toMatchObject({
      layer: 'ours',
      value: 'sso',
      decision_id: 'D-0001',
    });
    const approved = agendaOf(agendaId);
    expect(approved.in_force).toEqual({
      content_hash: approved.approval?.content_hash,
      approved_at: NOW,
      pinned_ids: ['D-0001', 'D-0002'],
    });

    // Edit our decision for nfr.auth; the edit is not approved yet.
    const file = path.join(dir, 'edit-ours.json');
    const entries = ENTRIES.map((entry) =>
      entry.entry_id === 'nfr.auth'
        ? { ...entry, our_decision: { value: 'password', rationale: 'cheaper' } }
        : entry
    );
    safeWriteFile(file, JSON.stringify({ entries }), { encoding: 'utf8' });
    await run(['draft', ...base(), '--agenda', agendaId, '--file', file]);
    const edited = agendaOf(agendaId);
    expect(edited.approval).toBeUndefined();
    expect(edited.in_force).toEqual(approved.in_force);
    expect((await customerRun('view', { token })).out).toMatchObject({ state: 'updating' });

    // What was approved stays in force: no fallback to the org default, no switch.
    const after = (await run(['status', ...base(), '--agenda', agendaId])) as Record<
      string,
      unknown
    >;
    expect(after.effective).toEqual(before.effective);
    expect(after.approval_current).toBe(false);
    expect(readSwitches({ dir })).toEqual([]);

    // Re-approval pins the edited decision and replaces what is in force.
    approveNext('apr-2');
    await run(['submit', ...base(), '--agenda', agendaId, '--by', 'user:alice']);
    const reapproved = agendaOf(agendaId);
    expect(reapproved.in_force?.pinned_ids).toEqual(['D-0003', 'D-0004']);
    const status = (await run(['status', ...base(), '--agenda', agendaId])) as Record<
      string,
      unknown
    >;
    expect(pick(status.effective, 'nfr.auth')).toMatchObject({
      layer: 'ours',
      value: 'password',
      decision_id: 'D-0003',
    });
  });

  it('completes a respond cut off after the ledger write, on status or on retry', async () => {
    const { agendaId, token, inviteId } = await approvedAndSent();
    const view = await customerRun('view', { token });
    const body = {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
    };
    // The process dies (throws) right after the ledger append.
    mocks.writeReceipt.mockImplementationOnce(() => {
      throw new Error('[TEST_CRASH_AFTER_LEDGER] simulated');
    });
    const failed = await customerRun('respond', body);
    expect(failed).toEqual({
      code: 1,
      out: { ok: false, reason: 'unavailable', diagnostic_code: 'TEST_CRASH_AFTER_LEDGER' },
    });
    // The unexpected failure leaves an unsilenced trace with its code, never the token.
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'respond',
        result: 'failed',
        reason: 'TEST_CRASH_AFTER_LEDGER',
      })
    );
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(token.split('.')[1]);
    const decided = readLedger({ dir }).filter((record) => record.state === 'decided');
    expect(decided).toHaveLength(1);
    const evidence = decided[0].decided_by?.on_behalf_of?.evidence as string;
    expect(listReceipts({ dir })).toEqual([]);
    expect(readSwitches({ dir })).toEqual([]);

    // The next status of the case completes it from the journal.
    mocks.audit.mockClear();
    const status = (await run(['status', ...base(), '--agenda', agendaId])) as Record<
      string,
      unknown
    >;
    expect(status.reconciled).toEqual({ completed: [evidence], abandoned: [], stuck: [] });
    expect(status.unreconciled_decisions).toEqual([]);
    const receipts = listReceipts({ dir });
    expect(receipts.map((receipt) => [receipt.receipt_id, receipt.decision_ids])).toEqual([
      [evidence, [decided[0].id]],
    ]);
    expect(readSwitches({ dir }).map((item) => [item.entry_id, item.cause_receipt_id])).toEqual([
      ['nfr.auth', evidence],
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'respond',
        result: 'completed',
        metadata: expect.objectContaining({ receipt_id: evidence, recovered: true }),
      })
    );
    expect(
      JSON.parse(
        String(
          safeReadFile(path.join(dir, 'brief-input', `${agendaId}.json`), { encoding: 'utf8' })
        )
      ).decisions[0]
    ).toMatchObject({ entry_id: 'nfr.auth', value: 'password', layer: 'customer' });

    // The customer retries: no second decision, the recovered receipt comes back.
    const retry = await customerRun('respond', body);
    expect(retry.out).toMatchObject({ ok: true, receipt_id: evidence, duplicate: true });
    expect(readLedger({ dir }).filter((record) => record.state === 'decided')).toHaveLength(1);
    expect(listReceipts({ dir })).toHaveLength(1);
    expect(readSwitches({ dir })).toHaveLength(1);
    expect(inviteId).toMatch(/^inv-/u);
  });

  it('completes the switches of a respond cut off after its receipt, on the next respond', async () => {
    const { agendaId, token } = await approvedAndSent();
    const view = await customerRun('view', { token });
    mocks.appendSwitches.mockImplementationOnce(() => {
      throw new Error('[TEST_CRASH_AFTER_RECEIPT] simulated');
    });
    const failed = await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
    });
    expect(failed.out).toMatchObject({
      reason: 'unavailable',
      diagnostic_code: 'TEST_CRASH_AFTER_RECEIPT',
    });
    const [receipt] = listReceipts({ dir });
    expect(receipt.decision_ids).toHaveLength(1);
    expect(readSwitches({ dir })).toEqual([]);
    // The respond audit was written right after ledger + receipt, before the failing step.
    const respondAudits = () =>
      mocks.audit.mock.calls.filter(
        ([entry]) => entry.operation === 'respond' && entry.result === 'completed'
      );
    expect(respondAudits()).toHaveLength(1);

    // Another answer (a different entry) repairs the first run before planning its own.
    const second = await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'nfr.locale', choice: 'option', value: ['ja'] }],
    });
    expect(second.out).toMatchObject({ ok: true, switches: 1 });
    expect(readSwitches({ dir }).map((item) => [item.entry_id, item.cause_receipt_id])).toEqual([
      ['nfr.auth', receipt.receipt_id],
      ['nfr.locale', second.out.receipt_id],
    ]);
    // The first run's audit is not repeated; ids stay unique.
    expect(respondAudits()).toHaveLength(2);
    const ids = readLedger({ dir }).map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
    const status = (await run(['status', ...base(), '--agenda', agendaId])) as Record<
      string,
      unknown
    >;
    expect(status.reconciled).toEqual({ completed: [], abandoned: [], stuck: [] });
  });

  it('records one respond audit entry when a run is cut off around the audit append', async () => {
    const { agendaId, token } = await approvedAndSent();
    const view = await customerRun('view', { token });
    const respondAudits = () =>
      mocks.audit.mock.calls.filter(
        ([entry]) => entry.operation === 'respond' && entry.result === 'completed'
      );
    // The audit append lands in the chain, then the process dies before the journal says so.
    const chain: unknown[] = [];
    mocks.audit.mockImplementation((entry: Record<string, unknown>) => {
      if (entry.operation === 'respond' && entry.result === 'completed' && chain.length === 0) {
        chain.push({ ...entry, tenantSlug: TENANT });
        throw new Error('[TEST_CRASH_AFTER_AUDIT] simulated');
      }
    });
    mocks.loadAll.mockImplementation(() => chain);
    const failed = await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
    });
    expect(failed.out).toMatchObject({ diagnostic_code: 'TEST_CRASH_AFTER_AUDIT' });
    expect(respondAudits()).toHaveLength(1);
    const status = (await run(['status', ...base(), '--agenda', agendaId])) as Record<
      string,
      unknown
    >;
    const [receipt] = listReceipts({ dir });
    expect(status.reconciled).toEqual({
      completed: [receipt.receipt_id],
      abandoned: [],
      stuck: [],
    });
    // The chain already held it: no second `respond completed` entry.
    expect(respondAudits()).toHaveLength(1);
    expect(mocks.loadAll).toHaveBeenCalled();
    expect(readSwitches({ dir }).map((item) => item.entry_id)).toEqual(['nfr.auth']);
  });

  it('records the respond audit on recovery when the chain does not hold it', async () => {
    const { agendaId, token } = await approvedAndSent();
    const view = await customerRun('view', { token });
    let thrown = false;
    mocks.audit.mockImplementation((entry: Record<string, unknown>) => {
      if (entry.operation === 'respond' && entry.result === 'completed' && !thrown) {
        thrown = true;
        throw new Error('[TEST_AUDIT_LOST] simulated');
      }
    });
    await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
    });
    mocks.audit.mockClear();
    await run(['status', ...base(), '--agenda', agendaId]);
    expect(
      mocks.audit.mock.calls.filter(
        ([entry]) => entry.operation === 'respond' && entry.result === 'completed'
      )
    ).toEqual([
      [expect.objectContaining({ metadata: expect.objectContaining({ recovered: true }) })],
    ]);
  });

  it('reports a journal record that cannot be completed and keeps the case working', async () => {
    const { agendaId, token } = await approvedAndSent();
    const view = await customerRun('view', { token });
    mocks.writeReceipt.mockImplementationOnce(() => {
      throw new Error('[TEST_CRASH_AFTER_LEDGER] simulated');
    });
    await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
    });
    const stuckId = readLedger({ dir }).find((record) => record.state === 'decided')?.decided_by
      ?.on_behalf_of?.evidence as string;
    // Completion of that record fails again; status still answers and reports it.
    mocks.audit.mockClear();
    mocks.writeReceipt.mockImplementationOnce(() => {
      throw new Error('[TEST_RECONCILE_BROKEN] simulated');
    });
    const status = (await run(['status', ...base(), '--agenda', agendaId])) as Record<
      string,
      unknown
    >;
    expect(status.reconciled).toEqual({
      completed: [],
      abandoned: [],
      stuck: [{ receipt_id: stuckId, reason: 'TEST_RECONCILE_BROKEN' }],
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'respond_reconcile',
        result: 'failed',
        reason: 'TEST_RECONCILE_BROKEN',
        metadata: expect.objectContaining({ receipt_id: stuckId }),
      })
    );
    // A new respond is not blocked by the bad record (whose completion fails once more).
    mocks.writeReceipt.mockImplementationOnce(() => {
      throw new Error('[TEST_RECONCILE_BROKEN] simulated');
    });
    const second = await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'nfr.locale', choice: 'option', value: ['ja'] }],
    });
    expect(second.out).toMatchObject({ ok: true });
    // Once the store recovers, the record completes.
    const healed = (await run(['status', ...base(), '--agenda', agendaId])) as Record<
      string,
      unknown
    >;
    expect(healed.reconciled).toEqual({ completed: [stuckId], abandoned: [], stuck: [] });
  });

  it('closes or withdraws an agenda, ending its links and the overlap block', async () => {
    const { agendaId, token, inviteId } = await approvedAndSent();
    const end = (verb: 'close' | 'withdraw', id: string, extra: string[] = []) =>
      run([verb, ...base(), '--agenda', id, ...extra]);
    await expect(end('close', agendaId)).rejects.toThrow(/--by user:<member> is required/u);
    const closed = (await end('close', agendaId, ['--by', 'user:alice'])) as Record<
      string,
      unknown
    >;
    expect(closed).toMatchObject({ status: 'closed', revoked_invites: [] });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'agenda_close',
        metadata: expect.objectContaining({ agenda_id: agendaId, by: 'user:alice' }),
      })
    );
    expect((await customerRun('view', { token })).out).toMatchObject({ ok: true, state: 'closed' });
    expect(await end('close', agendaId, ['--by', 'user:alice'])).toMatchObject({ already: true });
    await expect(end('withdraw', agendaId, ['--by', 'user:alice'])).rejects.toThrow(
      /already closed/u
    );

    // The same item × key may be asked again once the agenda is closed.
    const next = await draftAgenda();
    approveNext('apr-2');
    await run(['submit', ...base(), '--agenda', next, '--by', 'user:alice']);
    const sent = (await run([
      'send',
      ...base(),
      '--agenda',
      next,
      '--name',
      'Hanako',
      '--role',
      'decider',
      '--actor',
      ACTOR,
    ])) as { link: string; invite_id: string };
    const withdrawn = (await end('withdraw', next, [
      '--by',
      'user:alice',
      '--reason',
      'scope changed',
    ])) as Record<string, unknown>;
    expect(withdrawn).toMatchObject({ status: 'withdrawn', revoked_invites: [sent.invite_id] });
    expect((await customerRun('view', { token: sent.link.split('#t=')[1] })).out).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'agenda_withdraw',
        metadata: expect.objectContaining({
          reason: 'scope changed',
          revoked_invites: [sent.invite_id],
        }),
      })
    );
    expect(inviteId).not.toBe(sent.invite_id);
    await draftAgenda();
  });

  // Spawns the built `decisions` facade (another process), like the customer-room integration suite.
  const decisionsScript = pathResolver.rootResolve('dist/scripts/decisions.js');
  it.skipIf(!safeExistsSync(decisionsScript))(
    'serializes a concurrent pnpm decisions writer with a customer respond (nothing lost)',
    async () => {
      const { token } = await approvedAndSent();
      const view = await customerRun('view', { token });
      let child: ReturnType<typeof safeSpawn> | undefined;
      let childOut = '';
      // Right after the respond pre-assigned its ledger ids (journal written,
      // ledger not yet), an operator `pnpm decisions propose` runs in another process.
      mocks.writeRespondJournal.mockImplementationOnce((...args: unknown[]) => {
        const written = mocks.real.writeRespondJournal!(...args);
        child = safeSpawn(
          process.execPath,
          [
            decisionsScript,
            'propose',
            '--dir',
            dir,
            '--case',
            CASE,
            '--item',
            'OPS',
            '--key',
            'ops.note',
            '--level',
            'customer-value',
            '--value',
            '"from the operator"',
            '--json',
          ],
          { cwd: pathResolver.rootDir(), stdio: ['ignore', 'pipe', 'pipe'] }
        );
        child.stdout?.on('data', (chunk) => (childOut += String(chunk)));
        // Give the child ample time to start and reach the ledger (it runs in ~0.2 s unblocked).
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
        return written;
      });
      const response = await customerRun('respond', {
        token,
        content_hash: view.out.content_hash,
        answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
      });
      expect(response.out).toMatchObject({ ok: true });
      const code = await new Promise<number | null>((resolve) => child!.on('close', resolve));
      expect(code).toBe(0);
      const ledger = readLedger({ dir });
      const [receipt] = listReceipts({ dir });
      // The respond's planned ids landed as planned, and the operator record too.
      expect(
        receipt.decision_ids.map((id) => ledger.find((record) => record.id === id)?.key)
      ).toEqual(['auth.method']);
      expect(ledger.filter((record) => record.key === 'ops.note')).toHaveLength(1);
      expect(JSON.parse(childOut).appended[0].id).toBe(ledger.at(-1)?.id);
      const ids = ledger.map((record) => record.id);
      expect(new Set(ids).size).toBe(ids.length);
    },
    30_000
  );

  it('notes switches on the deal as the narrow deal-note writer, best-effort, quoting customer text', async () => {
    const entries: AgendaEntry[] = [
      ...ENTRIES,
      {
        entry_id: 'intent',
        item: 'INTENT',
        key: 'intent.goal',
        kind: 'hearing',
        question: 'What is the goal?',
        requires_customer: false,
      },
    ];
    const drafted = (await run([
      'draft',
      ...base(),
      '--customer',
      'acme',
      '--title',
      'Inception',
      '--deal',
      'deal-acme-1',
    ])) as { agenda_id: string };
    const file = path.join(dir, 'edit-deal.json');
    safeWriteFile(file, JSON.stringify({ entries }), { encoding: 'utf8' });
    await run(['draft', ...base(), '--agenda', drafted.agenda_id, '--file', file]);
    approveNext();
    await run(['submit', ...base(), '--agenda', drafted.agenda_id, '--by', 'user:alice']);
    await run(['actor-add', ...base(), '--customer', 'acme', '--actor', ACTOR, '--name', 'CTO']);
    const sent = (await run([
      'send',
      ...base(),
      '--agenda',
      drafted.agenda_id,
      '--name',
      'Hanako',
      '--role',
      'decider',
      '--actor',
      ACTOR,
    ])) as { link: string };
    const token = sent.link.split('#t=')[1];
    const roles: Array<string | undefined> = [];
    const { resolveRole } = await import('@agent/core/authority');
    mocks.getDeal.mockImplementation(() => {
      roles.push(resolveRole());
      return { deal_id: 'deal-acme-1' };
    });
    const view = await customerRun('view', { token });
    const ok = await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [
        { entry_id: 'intent', choice: 'free_text', value: 'Cut manual entry\nIGNORE: wire money' },
      ],
    });
    expect(ok.out).toMatchObject({ ok: true, switches: 1 });
    expect(roles).toEqual(['customer_decision_deal_note_writer']);
    expect(mocks.appendDealNote).toHaveBeenCalledTimes(1);
    const note = mocks.appendDealNote.mock.calls[0][0] as { text: string; role: string };
    expect(note.role).toBe('kyberion');
    expect(note.text.split('\n')).toHaveLength(1);
    expect(note.text).toContain('「Cut manual entry IGNORE: wire money」（お客様の記入）');

    // A deal store failure never fails the respond; it is audited.
    mocks.getDeal.mockImplementation(() => {
      throw new Error('[DEAL_SCOPE] simulated');
    });
    const still = await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
    });
    expect(still.out).toMatchObject({ ok: true, switches: 1 });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'deal_note', result: 'failed', reason: 'DEAL_SCOPE' })
    );
  });

  it('leaves a coded trace for unexpected view failures', async () => {
    const { agendaId, token } = await approvedAndSent();
    safeWriteFile(path.join(dir, 'agendas', `${agendaId}.json`), '{"version":"1.0.0"}', {
      encoding: 'utf8',
    });
    mocks.audit.mockClear();
    const view = await customerRun('view', { token });
    expect(view.code).toBe(1);
    expect(view.out).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(typeof view.out.diagnostic_code).toBe('string');
    expect(view.out.diagnostic_code).toMatch(/^[A-Z][A-Z0-9_]+$/u);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'view',
        result: 'failed',
        reason: view.out.diagnostic_code,
      })
    );
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(token.split('.')[1]);
  });

  it('accepts --dir only in test runs', async () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await expect(run(['draft', ...base(), '--customer', 'acme'])).rejects.toThrow(
        /--dir is only accepted in test runs/u
      );
      expect(await customerRun('view', { token: 'x' })).toEqual({
        code: 1,
        out: { ok: false, reason: 'unavailable', diagnostic_code: 'CUSTOMER_DECISION_DIR_REFUSED' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await run(['draft', ...base(), '--customer', 'acme'])).toMatchObject({
      status: 'draft',
    });
  });

  it('refuses layer orders that do not start with the customer', async () => {
    const drafted = (await run(['draft', ...base(), '--customer', 'acme'])) as {
      agenda_id: string;
    };
    const file = path.join(dir, 'layers.json');
    for (const layers of [
      ['ours', 'customer'],
      ['ours', 'org_default'],
    ]) {
      safeWriteFile(file, JSON.stringify({ entries: [{ ...ENTRIES[0], layers }] }), {
        encoding: 'utf8',
      });
      await expect(
        run(['draft', ...base(), '--agenda', drafted.agenda_id, '--file', file])
      ).rejects.toThrow(/layers_(customer_not_first|missing_customer)/u);
    }
    safeWriteFile(
      file,
      JSON.stringify({ entries: [{ ...ENTRIES[0], layers: ['customer', 'org_default'] }] }),
      { encoding: 'utf8' }
    );
    await run(['draft', ...base(), '--agenda', drafted.agenda_id, '--file', file]);
    expect(agendaOf(drafted.agenda_id).entries[0].layers).toEqual(['customer', 'org_default']);
  });

  it('refuses the same item × key in two open agendas of a case', async () => {
    const first = await draftAgenda();
    const second = (await run([
      'draft',
      ...base(),
      '--customer',
      'acme',
      '--template',
      'aidlc-inception',
    ]).catch((error: Error) => error)) as Error | { agenda_id: string };
    // The template overlaps nothing in ENTRIES, so a second agenda drafts fine.
    expect(second).toHaveProperty('agenda_id');
    const secondId = (second as { agenda_id: string }).agenda_id;
    const file = path.join(dir, 'overlap.json');
    safeWriteFile(file, JSON.stringify({ entries: [{ ...ENTRIES[0], entry_id: 'again' }] }), {
      encoding: 'utf8',
    });
    await expect(run(['draft', ...base(), '--agenda', secondId, '--file', file])).rejects.toThrow(
      new RegExp(`already asked in open agenda ${first}`, 'u')
    );
    // A withdrawn agenda no longer holds its keys.
    const withdrawn = { ...agendaOf(first), status: 'withdrawn' as const };
    const { writeAgenda } = await import('@agent/core/customer-decision');
    const { withExecutionContext } = await import('@agent/core/authority');
    withExecutionContext(
      'decision_ledger',
      () => writeAgenda({ dir }, withdrawn),
      undefined,
      TENANT
    );
    await run(['draft', ...base(), '--agenda', secondId, '--file', file]);
    expect(agendaOf(secondId).entries.map((entry) => entry.entry_id)).toEqual(['again']);
  });

  it('files one rework WorkItem for a completed task that pinned a decision the customer switched (CD-09)', async () => {
    const { pinTaskDecisions, reconcileTaskDecisions } =
      await import('@agent/core/mission/mission-decision-lock');
    const coordination = await import('@agent/core/workforce/work-coordination');
    coordination.setWorkCoordinationNamespace(`customer-decision-cd09-${process.pid}`);
    coordination.clearWorkCoordinationStore();
    try {
      const { token, agendaId } = await approvedAndSent();
      const decisionCase = {
        tenantSlug: TENANT,
        caseId: CASE,
        source: 'project' as const,
        location: { dir },
      };
      const task = { missionId: 'MSN-CD09-FACADE', taskId: 'build' };
      expect(pinTaskDecisions(task, { decisionCase, now: NOW })?.pinned_count).toBe(4);
      // The task finishes before the customer answers: fresh, nothing filed.
      expect(reconcileTaskDecisions(task, { decisionCase, now: NOW })).toMatchObject({
        stale_count: 0,
        rework_work_item_ids: [],
      });
      const rework = () =>
        coordination.listWorkItems({}).filter((item) => item.item_id.startsWith('WI-CDR-'));
      expect(rework()).toEqual([]);

      const view = await customerRun('view', { token });
      const body = {
        token,
        content_hash: view.out.content_hash,
        answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
      };
      const response = await customerRun('respond', body);
      // The customer's response is unchanged by the sweep.
      expect(response.out).toMatchObject({ ok: true, switches: 1 });
      const items = rework();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        status: 'backlog',
        context: { tenant_slug: TENANT, mission_id: 'MSN-CD09-FACADE' },
        metadata: { case_id: CASE, consumer: 'mission-MSN-CD09-FACADE.build', stale_count: 1 },
      });
      // The shared WorkItem store gets no decision content.
      expect(JSON.stringify(items[0])).not.toMatch(/password|auth\.method|nfr\.auth|"NFR"/u);
      // A double submit and the completion check both find the same single item.
      await customerRun('respond', body);
      expect(reconcileTaskDecisions(task, { decisionCase, now: NOW }).rework_work_item_ids).toEqual(
        [items[0].item_id]
      );
      expect(rework().map((item) => item.item_id)).toEqual([items[0].item_id]);
      expect(agendaOf(agendaId).status).toBe('sent');
    } finally {
      coordination.clearWorkCoordinationStore();
      coordination.clearWorkCoordinationNamespace();
    }
  });

  describe('task proposals (CD-09 実装中の判断を顧客に回す)', () => {
    interface TaskProposalStatus {
      pending: { count: number; proposal_ids: string[] };
      awaiting_customer: Array<Record<string, unknown>>;
    }
    const decisionCase = () => ({
      tenantSlug: TENANT,
      caseId: CASE,
      source: 'project' as const,
      location: { dir },
    });
    const sendCollected = async (agendaId: string) => {
      approveNext();
      await run(['submit', ...base(), '--agenda', agendaId, '--by', 'user:alice']);
      await run(['actor-add', ...base(), '--customer', 'acme', '--actor', ACTOR, '--name', 'CTO']);
      const sent = (await run([
        'send',
        ...base(),
        '--agenda',
        agendaId,
        '--name',
        'Hanako',
        '--role',
        'decider',
        '--actor',
        ACTOR,
      ])) as { link: string };
      return sent.link.split('#t=')[1];
    };
    const taskStatus = async () =>
      ((await run(['status', ...base()])) as { task_proposals: TaskProposalStatus }).task_proposals;
    type Coordination = typeof import('@agent/core/workforce/work-coordination');
    const withCoordination = async (fn: (coordination: Coordination) => Promise<void>) => {
      const coordination = await import('@agent/core/workforce/work-coordination');
      coordination.setWorkCoordinationNamespace(`customer-decision-cd09-tp-${process.pid}`);
      coordination.clearWorkCoordinationStore();
      try {
        await fn(coordination);
      } finally {
        coordination.clearWorkCoordinationStore();
        coordination.clearWorkCoordinationNamespace();
      }
    };

    it('a task goes on with its proposal; collect → submit → a different customer answer files one rework', async () => {
      const { recordTaskDecisionProposals, reconcileTaskDecisions } =
        await import('@agent/core/mission/mission-decision-lock');
      await withCoordination(async (coordination) => {
        const task = { missionId: 'MSN-CD09-TP', taskId: 'build' };
        const recorded = recordTaskDecisionProposals(
          {
            ...task,
            requests: [
              {
                question: 'Which colour theme should the portal use?',
                item: 'UX',
                key: 'ui.theme',
                proposed_value: 'dark',
                options: [
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                ],
                requires_customer: false,
              },
            ],
          },
          { decisionCase: decisionCase(), now: NOW }
        );
        expect(recorded).toMatchObject({ case_found: true, recorded: 1, hold_proposal_ids: [] });
        const [proposalId] = recorded.proposal_ids;
        // The task completes on our proposal: nobody decided otherwise yet.
        expect(
          reconcileTaskDecisions(task, { decisionCase: decisionCase(), now: NOW })
        ).toMatchObject({ stale_count: 0, rework_work_item_ids: [] });
        expect(await taskStatus()).toMatchObject({
          pending: { count: 1, proposal_ids: [proposalId] },
          awaiting_customer: [],
        });

        const collected = (await run([
          'draft',
          ...base(),
          '--from-tasks',
          '--customer',
          'acme',
        ])) as { agenda_id: string };
        expect(collected).toMatchObject({ status: 'draft', collected: 1, added: 1, entries: 1 });
        const agendaId = collected.agenda_id;
        expect(agendaOf(agendaId).entries).toEqual([
          expect.objectContaining({
            entry_id: proposalId,
            kind: 'choice',
            our_decision: { value: 'dark' },
            requires_customer: false,
          }),
        ]);
        // Idempotent: a collected proposal is not added again.
        expect(await run(['draft', ...base(), '--from-tasks', '--customer', 'acme'])).toMatchObject(
          { collected: 0, added: 0 }
        );
        expect((await taskStatus()).pending.count).toBe(0);

        const token = await sendCollected(agendaId);
        const rework = () =>
          coordination.listWorkItems({}).filter((item) => item.item_id.startsWith('WI-CDR-'));
        expect(rework()).toEqual([]);
        const view = await customerRun('view', { token });
        const response = await customerRun('respond', {
          token,
          content_hash: view.out.content_hash,
          answers: [{ entry_id: proposalId, choice: 'option', value: 'light' }],
        });
        expect(response.out).toMatchObject({ ok: true, switches: 1 });
        const items = rework();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          metadata: { consumer: 'mission-MSN-CD09-TP.build', stale_count: 1 },
        });
        expect(JSON.stringify(items[0])).not.toMatch(/colour|ui\.theme|"light"|"dark"/u);
      });
    });

    it('a requires_customer proposal holds the task until the operator confirms the decision', async () => {
      const { recordTaskDecisionProposals } =
        await import('@agent/core/mission/mission-decision-lock');
      await withCoordination(async (coordination) => {
        const workItem = coordination.createWorkItem({
          title: 'build',
          description: 'build',
          status: 'blocked',
          metadata: { blocked_reason: 'awaiting_customer_decision' },
        });
        const held = recordTaskDecisionProposals(
          {
            missionId: 'MSN-CD09-HOLD',
            taskId: 'release',
            requests: [
              {
                question: 'May we release the order screen on 11/1?',
                item: 'RELEASE',
                key: 'order.release',
                requires_customer: true,
              },
            ],
            workItemId: workItem.item_id,
          },
          { decisionCase: decisionCase(), now: NOW }
        );
        expect(held.hold_proposal_ids).toEqual(held.proposal_ids);
        const [proposalId] = held.proposal_ids;
        expect((await taskStatus()).awaiting_customer).toEqual([
          expect.objectContaining({
            consumer: 'mission-MSN-CD09-HOLD.release',
            status: 'awaiting',
            proposal_ids: [proposalId],
            uncollected: 1,
          }),
        ]);
        const collected = (await run([
          'draft',
          ...base(),
          '--from-tasks',
          '--customer',
          'acme',
        ])) as { agenda_id: string };
        const agendaId = collected.agenda_id;
        // requires_customer: the customer approves the question itself (no decision of ours).
        expect(agendaOf(agendaId).entries[0]).toEqual({
          entry_id: proposalId,
          item: 'RELEASE',
          key: 'order.release',
          kind: 'approval',
          question: 'May we release the order screen on 11/1?',
          requires_customer: true,
        });
        const token = await sendCollected(agendaId);
        const view = await customerRun('view', { token });
        await customerRun('respond', {
          token,
          content_hash: view.out.content_hash,
          answers: [{ entry_id: proposalId, choice: 'approve' }],
        });
        // Decided but provisional: still awaiting the operator's confirmation.
        expect((await taskStatus()).awaiting_customer[0]).toMatchObject({
          status: 'awaiting',
          uncollected: 0,
          decision_ids: [],
        });
        approveNext('apr-tp');
        await run([
          'confirm',
          ...base(),
          '--agenda',
          agendaId,
          '--entry',
          proposalId,
          '--by',
          'user:alice',
        ]);
        const decisionId = readLedger({ dir }).find((record) => record.key === 'order.release')
          ?.id as string;
        expect((await taskStatus()).awaiting_customer[0]).toMatchObject({
          status: 'resolved',
          decision_ids: [decisionId],
          next: 'pnpm mission resume MSN-CD09-HOLD',
        });
        const noted = coordination.getWorkItem(workItem.item_id);
        expect(noted).toMatchObject({
          status: 'blocked',
          metadata: {
            customer_decision_hold: { status: 'resolved', decision_ids: [decisionId] },
          },
        });
        expect(JSON.stringify(noted)).not.toMatch(/order screen|order\.release|RELEASE/u);
      });
    });

    it('re-asks an unresolvable question (--reask): refusals, ids-only audit, idempotent', async () => {
      const { recordTaskDecisionProposals } =
        await import('@agent/core/mission/mission-decision-lock');
      const { readConsumedDecisionLock } = await import('@agent/core/customer-decision');
      const ask = (taskId: string, item: string, key: string) =>
        recordTaskDecisionProposals(
          {
            missionId: 'MSN-CD09-REASK',
            taskId,
            requests: [{ question: 'May we release on 11/1?', item, key, requires_customer: true }],
          },
          { decisionCase: decisionCase(), now: NOW }
        );
      const held = ask('release', 'RELEASE', 'order.release');
      const [proposalId] = held.hold_proposal_ids;
      const first = (await run(['draft', ...base(), '--from-tasks', '--customer', 'acme'])) as {
        agenda_id: string;
      };
      // Another task's question stays pending: not unresolvable.
      const other = ask('docs', 'DOCS', 'docs.tone');
      const [pendingId] = other.proposal_ids;
      const reask = (ids: string, ...extra: string[]) =>
        run(['draft', ...base(), '--from-tasks', '--reask', ids, ...extra]);
      // Awaiting on an open agenda: nothing to re-ask yet.
      await expect(reask(proposalId, '--by', 'user:alice')).rejects.toMatchObject({
        code: 2,
        message: expect.stringMatching(/is not unresolvable/u),
      });
      await run(['withdraw', ...base(), '--agenda', first.agenda_id, '--by', 'user:alice']);
      const status = await taskStatus();
      const hold = status.awaiting_customer.find(
        (item) => item.consumer === 'mission-MSN-CD09-REASK.release'
      );
      expect(hold).toMatchObject({
        status: 'unresolvable',
        unresolvable_proposal_ids: [proposalId],
      });
      expect(String(hold?.next)).toContain(`--from-tasks --reask ${proposalId}`);
      expect(String(hold?.next)).toContain(
        'pnpm mission supersede-task MSN-CD09-REASK release --by <new_task_id>'
      );

      // Refusals: no --by, a bad id, an id that is not unresolvable, an unknown id.
      await expect(reask(proposalId)).rejects.toThrow(/--by user:<member> is required/u);
      await expect(reask('not-an-id', '--by', 'user:alice')).rejects.toThrow(
        /--reask takes task proposal ids/u
      );
      await expect(reask(`${proposalId},${pendingId}`, '--by', 'user:alice')).rejects.toMatchObject(
        { code: 2, message: expect.stringMatching(new RegExp(`${pendingId} is not unresolvable`)) }
      );
      await expect(reask('tp-0000000000000000', '--by', 'user:alice')).rejects.toThrow(
        /not found in this case/u
      );
      // Nothing was written by the refused runs.
      expect(listAgendas({ dir }).map((agenda) => agenda.agenda_id)).toEqual([first.agenda_id]);

      const lockFile = `${dir}/consumers/mission-MSN-CD09-REASK.release.json`;
      const lockBeforeReask = String(safeReadFile(lockFile, { encoding: 'utf8' }));
      mocks.audit.mockClear();
      const reasked = (await reask(proposalId, '--by', 'user:alice', '--customer', 'acme')) as {
        agenda_id: string;
        reasked: number;
      };
      expect(reasked).toMatchObject({ status: 'draft', reasked: 1, added: 1, collected: 1 });
      expect(reasked.agenda_id).not.toBe(first.agenda_id);
      expect(agendaOf(reasked.agenda_id).entries).toEqual([
        expect.objectContaining({ entry_id: proposalId, requires_customer: true }),
      ]);
      // The facade's marker on the target agenda: what the guard binds the relink to.
      expect(agendaOf(reasked.agenda_id).reasked_proposals).toEqual([
        {
          proposal_id: proposalId,
          consumer: 'mission-MSN-CD09-REASK.release',
          by: 'user:alice',
          at: NOW,
        },
      ]);
      const lock = readConsumedDecisionLock({ dir }, 'mission-MSN-CD09-REASK.release');
      const entry = lock?.decisions.find((item) => item.proposal?.proposal_id === proposalId);
      expect(entry).toMatchObject({
        agenda_id: reasked.agenda_id,
        entry_id: proposalId,
        proposal: {
          collected_at: NOW,
          previous_links: [
            {
              agenda_id: first.agenda_id,
              entry_id: proposalId,
              collected_at: NOW,
              relinked_at: NOW,
              relinked_by: 'user:alice',
            },
          ],
        },
      });
      // The hold stays as it is: the task still waits for the customer.
      expect(lock?.hold).toEqual({ at: NOW });
      const audited = mocks.audit.mock.calls
        .map(([entry]) => entry as { operation: string; metadata: Record<string, unknown> })
        .filter((entry) => entry.operation === 'task_proposals_reask');
      expect(audited).toHaveLength(1);
      expect(audited[0].metadata).toMatchObject({
        agenda_id: reasked.agenda_id,
        proposal_ids: [proposalId],
        consumers: ['mission-MSN-CD09-REASK.release'],
        reasked_by: 'user:alice',
      });
      expect(JSON.stringify(audited[0])).not.toMatch(/release on 11\/1|order\.release|RELEASE/u);
      expect((await taskStatus()).awaiting_customer).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            consumer: 'mission-MSN-CD09-REASK.release',
            status: 'awaiting',
          }),
        ])
      );

      // Idempotent: a second run reports it and writes nothing.
      expect(await reask(proposalId, '--by', 'user:alice', '--customer', 'acme')).toMatchObject({
        collected: 0,
        reasked: 0,
        already_reasked: [proposalId],
      });
      expect(listAgendas({ dir })).toHaveLength(2);

      // N6: a run whose agenda (and marker) landed but whose lock relink did
      // not is finished by a rerun that reuses the marker — never a second one.
      safeWriteFile(lockFile, lockBeforeReask);
      await reask(proposalId, '--by', 'user:alice', '--customer', 'acme');
      expect(agendaOf(reasked.agenda_id).reasked_proposals).toHaveLength(1);
      const relinked = readConsumedDecisionLock({ dir }, 'mission-MSN-CD09-REASK.release');
      expect(
        relinked?.decisions.find((item) => item.proposal?.proposal_id === proposalId)
      ).toMatchObject({ agenda_id: reasked.agenda_id });
    });

    it('refuses to add task proposals to an agenda that is not a draft', async () => {
      const { agendaId } = await approvedAndSent();
      await expect(run(['draft', ...base(), '--from-tasks', '--agenda', agendaId])).rejects.toThrow(
        /adds to a draft agenda only/u
      );
    });

    describe('a requires_customer question never rides on an entry our decision settles', () => {
      const ask = (taskId: string, requires: boolean, now: string) =>
        import('@agent/core/mission/mission-decision-lock').then(
          ({ recordTaskDecisionProposals }) =>
            recordTaskDecisionProposals(
              {
                missionId: 'MSN-CD09-REQ',
                taskId,
                requests: [
                  {
                    question: 'Which sign-in method?',
                    item: 'NFR',
                    key: 'auth.method',
                    requires_customer: requires,
                    ...(requires ? {} : { proposed_value: 'sso' }),
                  },
                ],
              },
              { decisionCase: decisionCase(), now }
            )
        );
      const collect = async () =>
        (await run(['draft', ...base(), '--from-tasks', '--customer', 'acme'])) as {
          agenda_id: string | null;
          collected: number;
          promoted: number;
          conflicts?: Array<{ proposal_id: string; agenda_id: string }>;
        };
      const authEntry = (agendaId: string) =>
        agendaOf(agendaId).entries.find((entry) => entry.key === 'auth.method');

      it('ours first, then requires_customer (one collect): the entry is promoted', async () => {
        await ask('a', false, NOW);
        await ask('b', true, '2026-10-24T01:00:00.000Z');
        const collected = await collect();
        expect(collected).toMatchObject({ collected: 2, promoted: 1 });
        const entry = authEntry(collected.agenda_id!);
        expect(entry).toMatchObject({ requires_customer: true });
        expect(entry).not.toHaveProperty('our_decision');
      });

      it('requires_customer first, then ours: the entry stays requires_customer', async () => {
        await ask('a', true, NOW);
        await ask('b', false, '2026-10-24T01:00:00.000Z');
        const collected = await collect();
        expect(collected).toMatchObject({ collected: 2, promoted: 0 });
        expect(authEntry(collected.agenda_id!)).toMatchObject({ requires_customer: true });
        expect(authEntry(collected.agenda_id!)).not.toHaveProperty('our_decision');
      });

      it('an entry of another draft agenda is promoted and linked', async () => {
        const draftId = await draftAgenda();
        await ask('a', true, NOW);
        const collected = await collect();
        expect(collected).toMatchObject({ collected: 1, promoted: 1, agenda_id: null });
        expect(authEntry(draftId)).toMatchObject({ requires_customer: true });
        expect(authEntry(draftId)).not.toHaveProperty('our_decision');
      });

      it('a promoted entry never resolves to the stale ours its last approval pinned', async () => {
        const { agendaId } = await approvedAndSent();
        // Edit after approval: a draft whose in_force still pins our sso decision.
        const file = path.join(dir, 'edit.json');
        safeWriteFile(file, JSON.stringify({ entries: ENTRIES }), { encoding: 'utf8' });
        await run(['draft', ...base(), '--agenda', agendaId, '--file', file]);
        expect(agendaOf(agendaId)).toMatchObject({ status: 'draft' });
        expect(agendaOf(agendaId).in_force?.pinned_ids.length).toBeGreaterThan(0);
        await ask('a', true, NOW);
        expect(await collect()).toMatchObject({ collected: 1, promoted: 1 });
        expect(authEntry(agendaId)).toMatchObject({ requires_customer: true });
        const status = (await run(['status', ...base(), '--agenda', agendaId])) as {
          effective: unknown;
        };
        expect(pick(status.effective, 'nfr.auth')).toMatchObject({
          layer: 'none',
          status: 'awaiting_customer',
        });
        expect(pick(status.effective, 'nfr.auth')).not.toHaveProperty('value');
      });

      it('a sent agenda asking it without requires_customer leaves the question pending', async () => {
        const { agendaId } = await approvedAndSent();
        const recorded = await ask('a', true, NOW);
        const collected = await collect();
        expect(collected).toMatchObject({ collected: 0, promoted: 0 });
        expect(collected.conflicts).toEqual([
          { proposal_id: recorded.proposal_ids[0], agenda_id: agendaId, entry_id: 'nfr.auth' },
        ]);
        expect(authEntry(agendaId)).toMatchObject({ requires_customer: false });
        expect((await taskStatus()).pending.count).toBe(1);
      });
    });
  });

  describe('bolt review (CD-10)', () => {
    const MISSION_ID = 'MSN-BOLT-FACADE';
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
    const PNG_OTHER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8, 8, 8, 8]);
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    const SUMMARY = 'The order form now saves drafts.';
    const COMMENT = 'Please move the save button — secret-comment-text';
    const inCase = () => ({ tenantSlug: TENANT, caseId: CASE });
    const boltRun = (argv: string[], missionCase = inCase) =>
      runCustomerDecision(argv, { now: () => NOW, missionCase });
    const file = (name: string, data: string | Buffer) => {
      const target = path.join(dir, name);
      safeWriteFile(target, data);
      return target;
    };
    const draftArgs = (missionId = MISSION_ID, extra: string[] = []) => [
      'bolt-review',
      ...base(),
      '--mission',
      missionId,
      '--customer',
      'acme',
      '--locale',
      'en',
      '--summary-file',
      file('summary.md', SUMMARY),
      ...extra,
    ];
    const attachmentRun = async (body: unknown, tenant = TENANT) => {
      try {
        return (await runCustomerDecision(['attachment', '--tenant', tenant, '--dir', dir], {
          now: () => NOW,
          stdin: JSON.stringify(body),
        })) as Record<string, unknown>;
      } catch (error) {
        expect(error).toBeInstanceOf(ScriptExitError);
        return (error as ScriptExitError).returnValue as Record<string, unknown>;
      }
    };
    const sendReview = async (agendaId: string) => {
      approveNext();
      await run(['submit', ...base(), '--agenda', agendaId, '--by', 'user:alice']);
      await run(['actor-add', ...base(), '--customer', 'acme', '--actor', ACTOR, '--name', 'CTO']);
      const sent = (await run([
        'send',
        ...base(),
        '--agenda',
        agendaId,
        '--name',
        'Hanako',
        '--role',
        'decider',
        '--actor',
        ACTOR,
      ])) as { link: string };
      return sent.link.split('#t=')[1];
    };
    const answer = async (token: string, choice: string, comment?: string) => {
      const view = await customerRun('view', { token });
      return customerRun('respond', {
        token,
        content_hash: view.out.content_hash,
        answers: [{ entry_id: 'bolt_review', choice, ...(comment ? { comment } : {}) }],
      });
    };
    type Coordination = typeof import('@agent/core/workforce/work-coordination');
    const withCoordination = async (fn: (coordination: Coordination) => Promise<void>) => {
      const coordination = await import('@agent/core/workforce/work-coordination');
      coordination.setWorkCoordinationNamespace(`customer-decision-cd10-${process.pid}`);
      coordination.clearWorkCoordinationStore();
      try {
        await fn(coordination);
      } finally {
        coordination.clearWorkCoordinationStore();
        coordination.clearWorkCoordinationNamespace();
      }
    };
    const boltItems = (coordination: Coordination) =>
      coordination.listWorkItems({}).filter((item) => item.item_id.startsWith('WI-CDB-'));

    const agendaCount = () => listAgendas({ dir }).length;

    beforeEach(() => {
      mocks.addInboxEntry.mockReset();
      mocks.notify.mockClear();
      mocks.fileBoltReviewWorkItem.mockReset();
      mocks.fileBoltReviewWorkItem.mockImplementation((...args: unknown[]) =>
        mocks.realFileBolt!(...args)
      );
    });

    it('drafts one approval entry open until the next bolt, with the images and preview link', async () => {
      const drafted = (await boltRun(
        draftArgs(MISSION_ID, [
          '--attach',
          file('form.png', PNG),
          '--attach',
          file('form-again.png', PNG),
          '--preview-url',
          'https://preview.example.com/b1',
        ])
      )) as Record<string, unknown>;
      expect(drafted).toMatchObject({
        status: 'draft',
        entries: 1,
        bolt_mission_id: MISSION_ID,
        attachments: 1,
        links: 1,
      });
      const agenda = agendaOf(drafted.agenda_id as string);
      expect(agenda.bolt_mission_id).toBe(MISSION_ID);
      expect(agenda.entries).toHaveLength(1);
      expect(agenda.entries[0]).toMatchObject({
        entry_id: 'bolt_review',
        item: `bolt:${MISSION_ID}`,
        key: 'bolt.acceptance',
        kind: 'approval',
        question: 'Do you accept the results of this round of work?',
        our_decision: { value: { approved: true } },
        override_until: { kind: 'milestone', milestone: `bolt-after:${MISSION_ID}` },
        links: [{ label: 'Preview', url: 'https://preview.example.com/b1' }],
        attachments: [{ name: 'form.png', media_type: 'image/png', bytes: PNG.length }],
      });
      expect(agenda.entries[0].background).toContain(SUMMARY);
      // The same mission cannot be reviewed twice at once (one open item per bolt).
      await expect(boltRun(draftArgs())).rejects.toThrow(/already asked in open agenda/u);
    });

    it('refuses internal links, bad images and missions outside the case', async () => {
      for (const url of [
        'http://preview.example.com/',
        'https://localhost:3000/',
        'https://10.0.0.5/',
        'https://staging.internal/',
      ])
        await expect(boltRun(draftArgs(MISSION_ID, ['--preview-url', url]))).rejects.toThrow(
          /--preview-url refused/u
        );
      await expect(
        boltRun(draftArgs(MISSION_ID, ['--attach', file('fake.png', JPEG)]))
      ).rejects.toThrow(/TYPE_MISMATCH/u);
      await expect(
        boltRun(
          draftArgs(MISSION_ID, [
            '--attach',
            file('big.png', Buffer.concat([PNG, Buffer.alloc(512 * 1024)])),
          ])
        )
      ).rejects.toThrow(/at most 524288 bytes/u);
      await expect(
        boltRun(draftArgs(), () => ({ tenantSlug: TENANT, caseId: 'other-case' }))
      ).rejects.toThrow(/does not belong to case/u);
      await expect(boltRun(draftArgs(), () => null)).rejects.toThrow(
        /not found or has no decision case/u
      );
      // --project may only restate the mission's own project.
      const ofProject = () => ({ tenantSlug: TENANT, caseId: CASE, projectId: 'PRJ-OWN' });
      await expect(
        boltRun(draftArgs(MISSION_ID, ['--project', 'PRJ-OTHER']), ofProject)
      ).rejects.toThrow(/--project PRJ-OTHER is not the project of mission/u);
      await expect(boltRun(draftArgs(MISSION_ID, ['--project', 'PRJ-OWN']))).rejects.toThrow(
        /\(it has none\)/u
      );
      expect(agendaCount()).toBe(0);
      const restated = (await boltRun(
        draftArgs(MISSION_ID, ['--project', 'PRJ-OWN']),
        ofProject
      )) as { agenda_id: string };
      expect(agendaOf(restated.agenda_id).project_id).toBe('PRJ-OWN');
    });

    it('refuses internal links on any agenda write: draft --file, and submit of a hand-edited record', async () => {
      const drafted = (await boltRun(draftArgs())) as { agenda_id: string };
      const agenda = agendaOf(drafted.agenda_id);
      const withLink = (url: string) => [
        { ...agenda.entries[0], links: [{ label: 'Preview', url }] },
      ];
      for (const url of [
        'https://localhost/',
        'https://10.0.0.5/',
        'https://app.internal/',
        'https://[::127.0.0.1]/',
      ]) {
        const edit = file('edit.json', JSON.stringify({ entries: withLink(url) }));
        await expect(
          run(['draft', ...base(), '--agenda', drafted.agenda_id, '--file', edit])
        ).rejects.toThrow(/CUSTOMER_DECISION_LINK_REFUSED/u);
      }
      expect(agendaOf(drafted.agenda_id).entries[0].links).toBeUndefined();
      // A record edited by hand (outside the facade) never gets approved or sent.
      safeWriteFile(
        path.join(dir, 'agendas', `${drafted.agenda_id}.json`),
        JSON.stringify({ ...agenda, entries: withLink('https://staging.local/') })
      );
      approveNext();
      await expect(
        run(['submit', ...base(), '--agenda', drafted.agenda_id, '--by', 'user:alice'])
      ).rejects.toThrow(/CUSTOMER_DECISION_LINK_REFUSED/u);
      // Refused before the approval gate and before any ledger pin.
      expect(mocks.gate).not.toHaveBeenCalled();
      expect(readLedger({ dir })).toEqual([]);
    });

    it('serves only images listed on the sent agenda, same shape as an unknown link otherwise', async () => {
      const drafted = (await boltRun(
        draftArgs(MISSION_ID, ['--attach', file('form.png', PNG)])
      )) as { agenda_id: string };
      // Another review in the case stores another image the invite never shows.
      const other = (await boltRun(
        draftArgs('MSN-BOLT-OTHER', ['--attach', file('other.png', PNG_OTHER)])
      )) as { agenda_id: string };
      const token = await sendReview(drafted.agenda_id);
      const view = await customerRun('view', { token });
      const entry = (view.out.entries as Array<Record<string, unknown>>)[0];
      const attachments = entry.attachments as Array<Record<string, unknown>>;
      expect(attachments).toEqual([
        {
          id: expect.stringMatching(/^[a-f0-9]{64}$/u),
          name: 'form.png',
          media_type: 'image/png',
          bytes: PNG.length,
        },
      ]);
      expect(entry.links).toBeUndefined();
      const served = await attachmentRun({ token, attachment_id: attachments[0].id });
      expect(served).toEqual({
        ok: true,
        media_type: 'image/png',
        bytes_base64: PNG.toString('base64'),
      });
      const otherId = agendaOf(other.agenda_id).entries[0].attachments![0].id;
      const unknown = { ok: false, reason: 'invalid_link' };
      expect(await attachmentRun({ token, attachment_id: otherId })).toEqual(unknown);
      expect(await attachmentRun({ token, attachment_id: 'f'.repeat(64) })).toEqual(unknown);
      expect(await attachmentRun({ token, attachment_id: '../../x' })).toEqual(unknown);
      expect(
        await attachmentRun({
          token: 'inv-0000000000000000.nope',
          attachment_id: attachments[0].id,
        })
      ).toEqual(unknown);
      // Another tenant's room never opens this tenant's invite (that tenant is
      // not registered, so its room answers unavailable before any lookup — CD-10).
      expect(
        await attachmentRun({ token, attachment_id: attachments[0].id }, 'other-tenant')
      ).toEqual({ ok: false, reason: 'unavailable' });
      // Fetching images does not count as a use of the invite.
      const status = (await run(['status', ...base(), '--agenda', drafted.agenda_id])) as {
        invites: Array<{ uses: number }>;
      };
      expect(status.invites[0].uses).toBe(1);
    });

    it('request_changes files one backlog WorkItem (ids only); status shows it', async () => {
      await withCoordination(async (coordination) => {
        const drafted = (await boltRun(draftArgs())) as { agenda_id: string };
        const token = await sendReview(drafted.agenda_id);
        expect((await answer(token, 'request_changes', COMMENT)).out).toMatchObject({ ok: true });
        // The same answer twice: still one item.
        expect((await answer(token, 'request_changes', COMMENT)).out).toMatchObject({ ok: true });
        const items = boltItems(coordination);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          status: 'backlog',
          context: { tenant_slug: TENANT, mission_id: MISSION_ID, work_shape: 'solution_project' },
          metadata: { agenda_id: drafted.agenda_id, entry_id: 'bolt_review' },
        });
        expect(JSON.stringify(items[0])).not.toContain('secret-comment-text');
        expect(mocks.addInboxEntry).not.toHaveBeenCalled();
        const status = (await run(['status', ...base(), '--agenda', drafted.agenda_id])) as {
          bolt_review: Record<string, unknown>;
        };
        expect(status.bolt_review).toMatchObject({
          mission_id: MISSION_ID,
          milestone: `bolt-after:${MISSION_ID}`,
          next_bolt_started: false,
          routing: [
            {
              entry_id: 'bolt_review',
              outcome: 'request_changes',
              work_item_id: items[0].item_id,
              notified: false,
            },
          ],
        });
        // status re-runs the routing: nothing new.
        expect(boltItems(coordination)).toHaveLength(1);
      });
    });

    it('a routing failure never fails the response; status retries it', async () => {
      await withCoordination(async (coordination) => {
        const drafted = (await boltRun(draftArgs())) as { agenda_id: string };
        const token = await sendReview(drafted.agenda_id);
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        mocks.fileBoltReviewWorkItem.mockImplementationOnce(() => {
          throw new Error('[WORK_STORE_DOWN] store unavailable');
        });
        expect((await answer(token, 'request_changes', COMMENT)).out).toMatchObject({ ok: true });
        expect(boltItems(coordination)).toEqual([]);
        const ours = warn.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => !line.includes('[locale]'));
        expect(
          ours.some((line) => line.startsWith('bolt review routing skipped — WORK_STORE_DOWN'))
        ).toBe(true);
        expect(ours.join('\n')).not.toContain('secret-comment-text');
        const status = (await run(['status', ...base(), '--agenda', drafted.agenda_id])) as {
          bolt_review: { routing: unknown[] };
        };
        expect(status.bolt_review.routing).toHaveLength(1);
        expect(boltItems(coordination)).toHaveLength(1);
      });
    });

    it('a retryable rejection push is retried by the next status, never recorded as notified', async () => {
      const drafted = (await boltRun(draftArgs())) as { agenda_id: string };
      const token = await sendReview(drafted.agenda_id);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      mocks.notify.mockImplementationOnce(() => ({ status: 'retryable' as never }));
      expect((await answer(token, 'reject', COMMENT)).out).toMatchObject({ ok: true });
      expect(agendaOf(drafted.agenda_id).bolt_routing).toEqual([
        expect.not.objectContaining({ notified_at: expect.anything() }),
      ]);
      const status = (await run(['status', ...base(), '--agenda', drafted.agenda_id])) as {
        bolt_review: { routing: Array<Record<string, unknown>> };
      };
      expect(mocks.notify).toHaveBeenCalledTimes(2);
      expect(status.bolt_review.routing).toEqual([expect.objectContaining({ notified: true })]);
      warn.mockRestore();
    });

    it('reject notifies the operator with ids only and files no WorkItem', async () => {
      await withCoordination(async (coordination) => {
        const drafted = (await boltRun(draftArgs())) as { agenda_id: string };
        const token = await sendReview(drafted.agenda_id);
        expect((await answer(token, 'reject')).out).toMatchObject({
          ok: false,
          reason: 'invalid_answers',
          errors: [{ entry_id: 'bolt_review', error: 'text_required' }],
        });
        expect((await answer(token, 'reject', COMMENT)).out).toMatchObject({ ok: true });
        expect(boltItems(coordination)).toEqual([]);
        expect(mocks.addInboxEntry).toHaveBeenCalledTimes(1);
        expect(mocks.notify).toHaveBeenCalledTimes(1);
        expect(mocks.notify.mock.calls[0][0]).toBe('question');
        const sent = JSON.stringify([mocks.addInboxEntry.mock.calls, mocks.notify.mock.calls]);
        expect(sent).toContain(drafted.agenda_id);
        expect(sent).toContain(MISSION_ID);
        expect(sent).not.toContain('secret-comment-text');
        const status = (await run(['status', ...base(), '--agenda', drafted.agenda_id])) as {
          bolt_review: { routing: Array<Record<string, unknown>> };
        };
        expect(status.bolt_review.routing).toEqual([
          expect.objectContaining({
            outcome: 'reject',
            notified: true,
            inbox_entry_id: expect.stringMatching(/^INBOX-CDB-/u),
          }),
        ]);
        // Routed once: status does not notify again.
        expect(mocks.notify).toHaveBeenCalledTimes(1);
        // The reject is a customer decision that is not approved.
        const ledger = readLedger({ dir });
        expect(ledger.at(-1)?.value).toMatchObject({ approved: false, rejected: true });
      });
    });
  });
});

describe('tenantOf (the bound-tenant check every verb runs)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const mismatch = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ScriptExitError);
      expect((error as ScriptExitError).code).toBe(2);
      expect(String((error as Error).message)).toMatch(/CUSTOMER_DECISION_TENANT_MISMATCH/u);
      return;
    }
    throw new Error('tenantOf accepted the tenant');
  };

  it('takes --tenant when the process is unbound', () => {
    vi.stubEnv('KYBERION_TENANT', '');
    expect(tenantOf({ tenant: TENANT })).toBe(TENANT);
  });

  it('takes the bound tenant and refuses another one', () => {
    vi.stubEnv('KYBERION_TENANT', TENANT);
    expect(tenantOf({ tenant: TENANT })).toBe(TENANT);
    mismatch(() => tenantOf({ tenant: 'cd-other-tenant' }));
  });

  it('fails closed on a bound tenant that is not a valid slug', () => {
    vi.stubEnv('KYBERION_TENANT', 'ACME');
    mismatch(() => tenantOf({ tenant: TENANT }));
    mismatch(() => tenantOf({ tenant: 'acme' }));
  });

  it('refuses another tenant inside a tenant-bound execution scope', () => {
    vi.stubEnv('KYBERION_TENANT', '');
    withExecutionContext(
      'decision_ledger',
      () => mismatch(() => tenantOf({ tenant: 'cd-other-tenant' })),
      undefined,
      TENANT
    );
  });
});
