import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from '@agent/core/authority';
import { rootDir } from '@agent/core/path-resolver';
import * as initialIO from '@agent/core/secure-io';

/**
 * The facade on a fresh root with no persona in env — the way the one-tenant
 * customer room child process runs it. The ordinary Vitest live-store remap
 * places invite bytes outside the protected root, so only a fixture root
 * exercises the real tier/tenant guard on the invite store.
 */
const mocks = vi.hoisted(() => ({ gate: vi.fn(), load: vi.fn(), audit: vi.fn() }));
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
  installReasoningBackendsForService: vi.fn(() => false),
}));

const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/cd-facade-boundary-' + process.pid);
const TENANT = 'cd-facade-boundary';
const OTHER = 'cd-facade-boundary-other';
/** Not in the fixture's tenant registry. */
const UNREGISTERED = 'cd-facade-unregistered';
const CASE = 'case-cd';
const NOW = '2026-10-24T00:00:00.000Z';
const ACTOR = 'customer:acme-cto';
const keys = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const savedRoot = process.env.KYBERION_ROOT;

let facade: typeof import('./customer_decision.js');
let io: typeof import('@agent/core/secure-io');
const dir = path.join(ROOT, 'active/shared/tmp/case');

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"cd-facade-fixture"}');
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
    // `draft` without --file builds from knowledge/product/orchestration/customer-decision-templates.
    copy('knowledge/product/orchestration');
    initialIO.safeMkdir(path.join(ROOT, 'active/shared/runtime'), { recursive: true });
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('@agent/core/secure-io');
  facade = await import('./customer_decision.js');
  expect((await import('@agent/core/path-resolver')).rootDir()).toBe(ROOT);
  process.env.KYBERION_PERSONA = 'sovereign';
  for (const tenant of [TENANT, OTHER])
    io.safeWriteFile(
      path.join(ROOT, 'knowledge/personal/tenants', `${tenant}.json`),
      JSON.stringify({ tenant_slug: tenant, status: 'active' })
    );
  io.safeMkdir(dir, { recursive: true });
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

describe('customer-decision facade without a confidential persona', () => {
  const run = (argv: string[], stdin?: string) =>
    facade.runCustomerDecision(argv, { now: () => NOW, ...(stdin !== undefined ? { stdin } : {}) });
  const base = () => ['--tenant', TENANT, '--case', CASE, '--dir', dir];
  const customer = async (verb: 'view' | 'respond', tenant: string, body: unknown) => {
    try {
      return {
        code: 0,
        out: (await run([verb, '--tenant', tenant, '--dir', dir], JSON.stringify(body))) as Record<
          string,
          unknown
        >,
      };
    } catch (error) {
      const failure = error as { code: number; returnValue: Record<string, unknown> };
      return { code: failure.code, out: failure.returnValue };
    }
  };

  it('sends, views and responds; another tenant cannot open the link', async () => {
    for (const key of keys) expect(process.env[key]).toBeUndefined();
    const drafted = (await run(['draft', ...base(), '--customer', 'acme', '--title', 'T'])) as {
      agenda_id: string;
    };
    const file = path.join(dir, 'edit.json');
    io.safeWriteFile(
      file,
      JSON.stringify({
        entries: [
          {
            entry_id: 'release',
            item: 'RELEASE',
            key: 'release.go',
            kind: 'approval',
            question: 'Release to production?',
            requires_customer: true,
          },
        ],
      })
    );
    await run(['draft', ...base(), '--agenda', drafted.agenda_id, '--file', file]);
    mocks.gate.mockReturnValueOnce({ allowed: true, status: 'approved', requestId: 'apr-1' });
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

    // The invite record lives in the real protected partition of the tenant.
    const inviteRoot = path.join(
      ROOT,
      'active/shared/runtime/customer-decision-invites/confidential'
    );
    expect(io.safeExistsSync(path.join(inviteRoot, TENANT))).toBe(true);
    // ...which the ambient (persona-less) identity cannot list.
    expect(() => io.safeReaddir(path.join(inviteRoot, TENANT))).toThrow(/Higher tier required/u);

    const view = await customer('view', TENANT, { token });
    expect(view).toMatchObject({ code: 0, out: { ok: true, state: 'open' } });
    const response = await customer('respond', TENANT, {
      token,
      content_hash: view.out.content_hash,
      answers: [{ entry_id: 'release', choice: 'approve' }],
    });
    expect(response.out).toMatchObject({ ok: true, switches: 1 });

    // Cross-tenant: the same token is not an invite of another tenant.
    expect(await customer('view', OTHER, { token })).toMatchObject({
      code: 1,
      out: { ok: false, reason: 'invalid_link' },
    });
    // A process bound to another tenant cannot read this tenant's store: unavailable, not invalid_link.
    process.env.KYBERION_TENANT = OTHER;
    try {
      expect((await customer('view', TENANT, { token })).out).toMatchObject({
        ok: false,
        reason: 'unavailable',
      });
    } finally {
      delete process.env.KYBERION_TENANT;
    }
  }, 60_000);

  const sendFor = async (tenant: string, entries: unknown[], extra: string[] = []) => {
    const args = ['--tenant', tenant, '--case', CASE, '--dir', dir];
    const drafted = (await run([
      'draft',
      ...args,
      '--customer',
      'acme',
      '--title',
      'T',
      ...extra,
    ])) as {
      agenda_id: string;
    };
    const file = path.join(dir, 'edit.json');
    io.safeWriteFile(file, JSON.stringify({ entries }));
    await run(['draft', ...args, '--agenda', drafted.agenda_id, '--file', file]);
    mocks.gate.mockReturnValueOnce({ allowed: true, status: 'approved', requestId: 'apr-2' });
    await run(['submit', ...args, '--agenda', drafted.agenda_id, '--by', 'user:alice']);
    await run(['actor-add', ...args, '--customer', 'acme', '--actor', ACTOR, '--name', 'CTO']);
    return run([
      'send',
      ...args,
      '--agenda',
      drafted.agenda_id,
      '--name',
      'Hanako',
      '--role',
      'decider',
      '--actor',
      ACTOR,
    ]) as Promise<{ link: string; agenda_id: string }>;
  };

  it('a tenant missing from the registry gets an actionable refusal, not a policy error', async () => {
    const inviteRoot = path.join(
      ROOT,
      'active/shared/runtime/customer-decision-invites/confidential'
    );
    // A fresh runtime root: no tier directory yet (the first send creates it).
    initialContext('ecosystem_architect', () =>
      initialIO.safeRmSync(inviteRoot, { recursive: true, force: true })
    );
    await expect(
      sendFor(UNREGISTERED, [
        {
          entry_id: 'release',
          item: 'RELEASE2',
          key: 'release.go',
          kind: 'approval',
          question: 'Release?',
          requires_customer: true,
        },
      ])
    ).rejects.toThrow(/CD_INVITE_TENANT_NOT_REGISTERED/u);
    expect(io.safeExistsSync(path.join(inviteRoot, UNREGISTERED))).toBe(false);
    // A registered tenant creates the tier directory on its first send.
    const sent = await sendFor(TENANT, [
      {
        entry_id: 'release',
        item: 'RELEASE3',
        key: 'release.go',
        kind: 'approval',
        question: 'Release?',
        requires_customer: true,
      },
    ]);
    expect(sent.link).toContain('#t=');
    expect(io.safeExistsSync(path.join(inviteRoot, TENANT))).toBe(true);
  }, 60_000);

  it('a rejected bolt review reaches the real inbox under the facade identity (CD-10)', async () => {
    for (const key of keys) expect(process.env[key]).toBeUndefined();
    const drafted = (await facade.runCustomerDecision(
      [
        'bolt-review',
        '--tenant',
        TENANT,
        '--case',
        CASE,
        '--dir',
        dir,
        '--mission',
        'MSN-BOUNDARY-BOLT',
        '--customer',
        'acme',
        '--summary-file',
        (() => {
          const summary = path.join(dir, 'summary.md');
          io.safeWriteFile(summary, 'What changed.');
          return summary;
        })(),
      ],
      { now: () => NOW, missionCase: () => ({ tenantSlug: TENANT, caseId: CASE }) }
    )) as { agenda_id: string };
    const args = ['--tenant', TENANT, '--case', CASE, '--dir', dir];
    mocks.gate.mockReturnValueOnce({ allowed: true, status: 'approved', requestId: 'apr-3' });
    await run(['submit', ...args, '--agenda', drafted.agenda_id, '--by', 'user:alice']);
    await run(['actor-add', ...args, '--customer', 'acme', '--actor', ACTOR, '--name', 'CTO']);
    const sent = (await run([
      'send',
      ...args,
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
    const view = await customer('view', TENANT, { token });
    const response = await customer('respond', TENANT, {
      token,
      content_hash: view.out.content_hash,
      answers: [
        { entry_id: 'bolt_review', choice: 'reject', comment: 'not this — secret-comment' },
      ],
    });
    expect(response.out).toMatchObject({ ok: true });
    const { listInboxEntries } = await import('@agent/core/deliverable-inbox');
    const entries = initialContext('surface_runtime', () =>
      listInboxEntries({ missionId: 'MSN-BOUNDARY-BOLT' })
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entry_id: expect.stringMatching(/^INBOX-CDB-/u),
      kind: 'customer_decision_bolt_rejected',
      tenant_slug: TENANT,
    });
    expect(JSON.stringify(entries[0])).not.toContain('secret-comment');
    const agenda = (await run(['status', ...args, '--agenda', drafted.agenda_id])) as {
      bolt_review: { routing: Array<Record<string, unknown>> };
    };
    expect(agenda.bolt_review.routing).toEqual([
      expect.objectContaining({ outcome: 'reject', inbox_entry_id: entries[0].entry_id }),
    ]);
  }, 60_000);
});
