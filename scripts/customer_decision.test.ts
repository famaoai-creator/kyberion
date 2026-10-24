import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { ScriptExitError } from '@agent/core/script-harness';
import { readLedger } from '@agent/core/decision-ledger';
import {
  agendaContentHash,
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
}));

vi.mock('@agent/core/governance/approval-gate', () => ({ enforceApprovalGate: mocks.gate }));
vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-store')>()),
  loadApprovalRequest: mocks.load,
}));
vi.mock('@agent/core/governance/audit-chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/governance/audit-chain')>();
  return { ...actual, auditChain: { ...actual.auditChain, record: mocks.audit } };
});
vi.mock('@agent/core/reasoning/reasoning-bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/reasoning/reasoning-bootstrap')>()),
  installReasoningBackendsForService: mocks.install,
}));

import { parseCustomerDecisionArgs, runCustomerDecision } from './customer_decision.js';

const TENANT = 'cd-facade-test';
const CASE = 'case-cd';
const NOW = '2026-10-24T00:00:00.000Z';
const ACTOR = 'customer:acme-cto';

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

describe('customer-decision facade', () => {
  let dir: string;
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
    });
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

    approveNext();
    await run(['submit', ...base(), '--agenda', drafted.agenda_id, '--by', 'user:alice']);
    await expect(
      run(['generate', ...base(), '--agenda', drafted.agenda_id, '--intent-file', intent])
    ).rejects.toThrow(/generate only fills a draft/u);
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
        correlationId: `${agendaId}:${hash}`,
        requestScope: { tenant_slug: TENANT },
        draft: expect.objectContaining({ summary: expect.stringContaining('ours: "sso"') }),
      })
    );
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
    expect(approved).toMatchObject({ status: 'approved', approved_by: 'user:boss' });
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
    expect(agenda.approval).toMatchObject({ content_hash: hash, request_id: 'apr-7' });
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
      current: { status: 'provisional', layer: 'ours', value: 'sso' },
      overridable: true,
    });
    expect(entries.find((entry) => entry.entry_id === 'release')?.current).toEqual({
      status: 'awaiting_customer',
      layer: 'none',
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
      String(safeReadFile(path.join(dir, 'brief-input.json'), { encoding: 'utf8' }))
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

  it('keeps a requires_customer entry awaiting until the decider decides', async () => {
    const { token } = await approvedAndSent();
    const view = await customerRun('view', { token });
    const response = await customerRun('respond', {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'release', choice: 'approve' }],
    });
    expect(response.out).toMatchObject({ ok: true, switches: 1 });
    const after = await customerRun('view', { token });
    expect(pick(after.out.entries, 'release')?.current).toEqual({
      status: 'confirmed',
      layer: 'customer',
      value: { approved: true },
    });
    expect(after.out.receipts).toHaveLength(1);
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
});
