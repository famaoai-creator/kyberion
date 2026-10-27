import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from '@agent/core/authority';
import { rootDir } from '@agent/core/path-resolver';
import * as initialIO from '@agent/core/secure-io';

/**
 * CD-12 on a fresh fixture root, through the real paths: the real case store
 * under knowledge/confidential/<tenant>/decisions/, the real invite store,
 * the real organization learning store. Only the agenda approval of `submit`
 * is stubbed (it is not what this file tests) and the reasoning bootstrap is
 * disabled.
 */
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@agent/core/governance/approval-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/governance/approval-gate')>();
  return {
    ...actual,
    enforceApprovalGate: (params: Parameters<typeof actual.enforceApprovalGate>[0]) =>
      params.operationId === 'customer_decision:agenda_approve'
        ? { allowed: true, status: 'approved', requestId: 'apr-agenda' }
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
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/cd-overview-boundary-' + process.pid);
const TENANT = 'cd-overview-a';
const OTHER = 'cd-overview-b';
const CASE = 'case-cd';
const DRAFT_CASE = 'case-draft';
const NOW = '2026-10-24T00:00:00.000Z';
const REPORT_DATE = '2026-10-24';
const ACTOR = 'customer:acme-cto';
const TITLE = 'Inception decisions';
const SECRETS = ['secret-comment-1', 'secret-comment-2', 'secret-comment-3', 'secret-question'];
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

/** Same rule as the reminders boundary test: skip the child run on a stale build. */
const DIST_FILES = [
  'dist/scripts/customer_decision.js',
  'dist/scripts/customer-decision/learning.js',
  'dist/scripts/customer-decision/learning-op.js',
  'libs/core/dist/customer-decision/learning.js',
  'libs/core/dist/operational-learning.js',
];
const SOURCE_DIRS = ['scripts/customer-decision', 'libs/core/customer-decision'];
const SOURCE_FILES = ['scripts/customer_decision.ts', 'libs/core/operational-learning.ts'];
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

/** Every file under the given fixture directories → sha256 of its bytes. */
function snapshot(dirs: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (relative: string): void => {
    const absolute = path.join(ROOT, relative);
    if (!io.safeExistsSync(absolute)) return;
    for (const name of io.safeReaddir(absolute)) {
      const file = path.join(relative, name);
      const stat = io.safeLstat(path.join(ROOT, file));
      if (stat.isDirectory()) walk(file);
      else
        files.set(
          file,
          createHash('sha256')
            .update(io.safeReadFile(path.join(ROOT, file), { encoding: null }) as Buffer)
            .digest('hex')
        );
    }
  };
  initialContext('ecosystem_architect', () => dirs.forEach(walk));
  return files;
}
const STORES = ['knowledge', 'customer', 'active/shared/runtime', 'active/organizations'];

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"cd-overview-fixture"}');
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
    copy('knowledge/public/common');
    initialIO.safeMkdir(path.join(ROOT, 'active/shared/runtime'), { recursive: true });
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('@agent/core/secure-io');
  facade = await import('./customer_decision.js');
  expect((await import('@agent/core/path-resolver')).rootDir()).toBe(ROOT);
  process.env.KYBERION_PERSONA = 'sovereign';
  for (const tenant of [TENANT, OTHER]) {
    writeFixtureJson(`knowledge/personal/tenants/${tenant}.json`, {
      tenant_slug: tenant,
      display_name: tenant,
      status: 'active',
      assigned_role: 'owner',
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

describe('customer-decision overview and learning (CD-12, real paths)', () => {
  const run = (argv: string[], now = NOW, stdin?: string) =>
    facade.runCustomerDecision(argv, {
      now: () => now,
      ...(stdin !== undefined ? { stdin } : {}),
    }) as Promise<Out>;
  const base = (caseId = CASE) => ['--tenant', TENANT, '--case', caseId];
  const respond = async (token: string, answers: unknown[], generalQuestion?: string) => {
    const view = await run(['view', '--tenant', TENANT], NOW, JSON.stringify({ token }));
    const out = await run(
      ['respond', '--tenant', TENANT],
      NOW,
      JSON.stringify({
        token,
        content_hash: view.content_hash,
        answers,
        ...(generalQuestion ? { general_question: generalQuestion } : {}),
      })
    );
    expect(out).toMatchObject({ ok: true });
  };
  let agendaId = '';

  it('builds a sent case with answers and a draft-only case', async () => {
    const drafted = await run([
      'draft',
      ...base(),
      '--customer',
      'acme',
      '--title',
      TITLE,
      '--locale',
      'en',
      '--respond-by',
      '2026-10-26',
    ]);
    agendaId = String(drafted.agenda_id);
    const file = path.join(ROOT, 'active/shared/tmp', 'overview-edit.json');
    io.safeWriteFile(
      file,
      JSON.stringify({
        entries: [
          {
            entry_id: 'retention',
            item: 'DATA',
            key: 'retention.days',
            kind: 'choice',
            question: 'How long to keep data?',
            options: [
              { value: 30, label: '30 days' },
              { value: 90, label: '90 days' },
            ],
            org_default: { value: 30, source: 'template:aidlc-inception' },
            requires_customer: false,
          },
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
    await run(['draft', ...base(), '--agenda', agendaId, '--file', file]);
    await run(['submit', ...base(), '--agenda', agendaId, '--by', 'user:alice']);
    await run(['actor-add', ...base(), '--customer', 'acme', '--actor', ACTOR, '--name', 'CTO']);
    const sent = await run([
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
    ]);
    const token = String(sent.link).split('#t=')[1];
    // The customer overturns the org default and answers sign-in three times outside the options.
    await respond(
      token,
      [
        { entry_id: 'retention', choice: 'option', value: 90 },
        { entry_id: 'auth', choice: 'free_text', comment: SECRETS[0] },
      ],
      SECRETS[3]
    );
    await respond(token, [{ entry_id: 'auth', choice: 'free_text', comment: SECRETS[1] }]);
    await respond(token, [{ entry_id: 'auth', choice: 'free_text', comment: SECRETS[2] }]);
    await run(['draft', ...base(DRAFT_CASE), '--customer', 'acme', '--title', 'Later']);
  }, 120_000);

  it('overview reads every case of the tenant and writes nothing', async () => {
    const before = snapshot(STORES);
    const out = (await run([
      'overview',
      '--tenant',
      TENANT,
      '--now',
      '2026-10-25T00:00:00.000Z',
    ])) as Out;
    expect(snapshot(STORES)).toEqual(before);
    expect(out).toMatchObject({
      version: '1.0.0',
      tenant_slug: TENANT,
      today: '2026-10-25',
      totals: { cases: 2, agendas: 2, open_agendas: 2 },
      case_failures: [],
    });
    const cases = out.cases as Array<Record<string, unknown>>;
    expect(cases.map((item) => item.case_id)).toEqual([CASE, DRAFT_CASE]);
    expect(cases[1]).toMatchObject({ draft_only: true });
    const [agenda] = cases[0].agendas as Array<Record<string, unknown>>;
    expect(agenda).toMatchObject({
      agenda_id: agendaId,
      title: TITLE,
      status: 'sent',
      answerable: true,
      active_invites: 1,
      respond_by: '2026-10-26',
      respond_by_days: 1,
      unanswered_deciders: 1,
      counts: {
        confirmed: 1,
        provisional: 1,
        awaiting_customer: 1,
        awaiting_operator_confirmation: 0,
        undecided: 0,
      },
    });
    expect(out.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'respond_by_due_soon', agenda_id: agendaId, days: 1 }),
        expect.objectContaining({ reason: 'awaiting_customer', agenda_id: agendaId, count: 1 }),
      ])
    );
    const text = JSON.stringify(out);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    // The summary form (the Chronos card): no entries, capped attention, full count.
    const summary = await run([
      'overview',
      '--tenant',
      TENANT,
      '--summary',
      '--now',
      '2026-10-25T00:00:00.000Z',
    ]);
    expect(snapshot(STORES)).toEqual(before);
    expect((summary.totals as Out).attention_total).toBe((out.attention as unknown[]).length);
    expect(summary.attention).toEqual(out.attention);
    const summaryAgenda = ((summary.cases as Out[])[0].agendas as Out[])[0];
    expect(summaryAgenda).not.toHaveProperty('entries');
    expect(summaryAgenda.counts).toEqual(agenda.counts);
    expect(out.totals).not.toHaveProperty('attention_total');
    // One case only.
    const one = await run(['overview', '--tenant', TENANT, '--case', DRAFT_CASE]);
    expect((one.cases as Out[]).map((item) => item.case_id)).toEqual([DRAFT_CASE]);
    await expect(run(['overview', '--tenant', TENANT, '--case', 'nope'])).rejects.toThrow(
      /case not found/u
    );
  }, 60_000);

  it('overview --case --detail reads one case in full and writes nothing', async () => {
    const before = snapshot(STORES);
    const at = '2026-10-25T00:00:00.000Z';
    const out = await run([
      'overview',
      '--tenant',
      TENANT,
      '--case',
      CASE,
      '--detail',
      '--now',
      at,
    ]);
    expect(snapshot(STORES)).toEqual(before);
    expect(out).toMatchObject({
      version: '1.0.0',
      tenant_slug: TENANT,
      case_id: CASE,
      today: '2026-10-25',
      draft_only: false,
      tasks: [],
      tasks_total: 0,
    });
    const [agenda] = out.agendas as Out[];
    expect(agenda).toMatchObject({
      agenda_id: agendaId,
      title: TITLE,
      entries_total: 3,
      invites: { active: 1, expired: 0, revoked: 0, deciders: 1, contributors: 0 },
      approval: { approved_at: expect.any(String) },
    });
    expect((agenda.entries as Out[]).map((entry) => entry.question)).toEqual([
      'How long to keep data?',
      'Which sign-in method?',
      'Release to production?',
    ]);
    // Three receipts carried something for the operator (comments, the general question).
    expect(agenda.handoffs_total).toBe(3);
    // Counts only: off-option answers and the general question (never their text).
    expect(
      (agenda.handoffs as Out[]).map((item) => [item.off_option, item.general_question])
    ).toEqual(
      expect.arrayContaining([
        [1, true],
        [1, false],
      ])
    );
    const text = JSON.stringify(out);
    for (const secret of [...SECRETS, 'Hanako', ACTOR, '30 days', '90 days', 'user:boss'])
      expect(text).not.toContain(secret);
    for (const field of ['"value"', '"options"', '"comment"', '"participant"', '"approved_by"'])
      expect(text).not.toContain(field);

    await expect(run(['overview', '--tenant', TENANT, '--detail'])).rejects.toThrow(
      /--detail needs --case/u
    );
    await expect(
      run(['overview', '--tenant', TENANT, '--case', CASE, '--detail', '--summary'])
    ).rejects.toThrow(/cannot be combined/u);
    await expect(
      run(['overview', '--tenant', TENANT, '--case', 'case-nope', '--detail'])
    ).rejects.toThrow(/\[CUSTOMER_DECISION_CASE_NOT_FOUND\]/u);
    expect(snapshot(STORES)).toEqual(before);
  }, 60_000);

  it('refuses a tenant other than the bound one', async () => {
    process.env.KYBERION_TENANT = OTHER;
    try {
      await expect(run(['overview', '--tenant', TENANT])).rejects.toThrow(/TENANT_MISMATCH/u);
      await expect(run(['learning', '--tenant', TENANT])).rejects.toThrow(/TENANT_MISMATCH/u);
      await expect(
        run(['overview', '--tenant', TENANT, '--case', CASE, '--detail'])
      ).rejects.toThrow(/TENANT_MISMATCH/u);
      await expect(run(['overview', '--tenant', TENANT, '--learning'])).rejects.toThrow(
        /TENANT_MISMATCH/u
      );
    } finally {
      delete process.env.KYBERION_TENANT;
    }
    // The other tenant sees none of this tenant's cases.
    const other = await run(['overview', '--tenant', OTHER]);
    expect(other).toMatchObject({ totals: { cases: 0, agendas: 0 }, cases: [] });
    await expect(run(['overview', '--tenant', OTHER, '--case', CASE, '--detail'])).rejects.toThrow(
      /\[CUSTOMER_DECISION_CASE_NOT_FOUND\]/u
    );
  }, 60_000);

  const reportFile = path.join(
    ROOT,
    'knowledge/confidential',
    TENANT,
    'decisions/_reports',
    `learning-${REPORT_DATE}.json`
  );
  const candidateFiles = (): string[] =>
    [...snapshot(['active/organizations']).keys()].filter((file) =>
      file.endsWith('candidate.json')
    );

  it('learning --dry-run computes the suggestions and writes nothing', async () => {
    const before = snapshot(STORES);
    const out = await run(['learning', '--tenant', TENANT, '--dry-run']);
    expect(snapshot(STORES)).toEqual(before);
    expect(out).toMatchObject({
      tenant: TENANT,
      dry_run: true,
      report_date: REPORT_DATE,
      report: `knowledge/confidential/${TENANT}/decisions/_reports/learning-${REPORT_DATE}.json`,
      cases: 2,
      counts: { suggestions: 1, created: 0 },
      suggestions: [
        expect.objectContaining({
          suggestion_key: 'clarify_entry:NFR/auth.method',
          candidate: 'would_queue',
        }),
      ],
    });
  }, 60_000);

  it('overview --learning shows no report before the first learning run', async () => {
    const out = await run(['overview', '--tenant', TENANT, '--learning']);
    expect(out).toMatchObject({
      version: '1.0.0',
      tenant_slug: TENANT,
      report_date: null,
      available_dates: [],
      generated_at: null,
      suggestions: [],
    });
    await expect(
      run(['overview', '--tenant', TENANT, '--learning', '--date', REPORT_DATE])
    ).rejects.toThrow(/\[CUSTOMER_DECISION_REPORT_NOT_FOUND\]/u);
  }, 60_000);

  it('learning writes the tenant report and queues each candidate once, in the tenant scope only', async () => {
    const out = await run(['learning', '--tenant', TENANT]);
    expect(out).toMatchObject({
      dry_run: false,
      counts: { suggestions: 1, created: 1, existing: 0 },
    });
    const [suggestion] = out.suggestions as Out[];
    expect(suggestion).toMatchObject({ candidate: 'created' });
    expect(suggestion.learning_id).toMatch(/^cdl-[a-f0-9]{16}$/u);
    const report = JSON.parse(
      initialContext('ecosystem_architect', () =>
        String(io.safeReadFile(reportFile, { encoding: 'utf8' }))
      )
    ) as Out;
    expect(report).toMatchObject({ tenant_slug: TENANT, report_date: REPORT_DATE });
    expect((report.metrics as Out).overturn_by_template_entry).toEqual([
      expect.objectContaining({
        template_id: 'aidlc-inception',
        entry_id: 'retention',
        from_layer: 'org_default',
        overturned: 1,
        customer_values: [{ value: 90, count: 1 }],
      }),
    ]);
    const reportText = JSON.stringify(report);
    for (const secret of SECRETS) expect(reportText).not.toContain(secret);

    const files = candidateFiles();
    expect(files).toEqual([
      path.join(
        'active/organizations/confidential',
        TENANT,
        'default/state/learning',
        String(suggestion.learning_id),
        'candidate.json'
      ),
    ]);
    const read = () =>
      initialContext('ecosystem_architect', () =>
        String(io.safeReadFile(path.join(ROOT, files[0]), { encoding: 'utf8' }))
      );
    const first = read();
    const candidate = JSON.parse(first) as Out;
    expect(candidate).toMatchObject({
      source_type: 'customer_decision',
      tier: 'confidential',
      tenant_slug: TENANT,
      status: 'proposed',
      target_kind: 'knowledge_hint',
      evidence_refs: [String(out.report)],
      metadata: expect.objectContaining({
        suggestion_key: 'clarify_entry:NFR/auth.method',
        kind: 'clarify_entry',
        item: 'NFR',
        key: 'auth.method',
        evidence: { samples: 1, count: 3 },
      }),
    });
    for (const secret of SECRETS) expect(first).not.toContain(secret);

    // A re-run the same day queues nothing and leaves the candidate untouched.
    const again = await run(['learning', '--tenant', TENANT], '2026-10-24T12:00:00.000Z');
    expect(again).toMatchObject({ counts: { created: 0, existing: 1 } });
    expect(read()).toBe(first);
    expect(candidateFiles()).toHaveLength(1);
    // A week later, or for another organization: the same suggestion with the
    // same evidence is not queued again (one standing candidate per tenant).
    const nextWeek = await run(['learning', '--tenant', TENANT], '2026-10-31T00:00:00.000Z');
    expect(nextWeek).toMatchObject({
      report_date: '2026-10-31',
      counts: { created: 0, existing: 1 },
      suggestions: [
        expect.objectContaining({ learning_id: suggestion.learning_id, candidate: 'existing' }),
      ],
    });
    const otherOrg = await run(['learning', '--tenant', TENANT, '--organization-id', 'other-org']);
    expect(otherOrg).toMatchObject({ counts: { created: 0, existing: 1 } });
    expect(candidateFiles()).toHaveLength(1);
    expect(read()).toBe(first);
    // The later report names the candidate that stands.
    const later = JSON.parse(
      initialContext('ecosystem_architect', () =>
        String(io.safeReadFile(reportFile.replace(REPORT_DATE, '2026-10-31'), { encoding: 'utf8' }))
      )
    ) as { suggestions: Out[] };
    expect(later.suggestions[0].learning_id).toBe(suggestion.learning_id);
    // The report directory is never a case.
    const overview = await run(['overview', '--tenant', TENANT]);
    expect((overview.cases as Out[]).map((item) => item.case_id)).toEqual([CASE, DRAFT_CASE]);
  }, 60_000);

  it('overview --learning reads the stored reports without values and writes nothing', async () => {
    const before = snapshot(STORES);
    const latest = await run(['overview', '--tenant', TENANT, '--learning']);
    expect(latest).toMatchObject({
      tenant_slug: TENANT,
      report_date: '2026-10-31',
      available_dates: [REPORT_DATE, '2026-10-31'],
    });
    const out = await run(['overview', '--tenant', TENANT, '--learning', '--date', REPORT_DATE]);
    expect(snapshot(STORES)).toEqual(before);
    expect(out).toMatchObject({
      report_date: REPORT_DATE,
      metrics: { cases: 2 },
      suggestions: [
        expect.objectContaining({
          suggestion_key: 'clarify_entry:NFR/auth.method',
          kind: 'clarify_entry',
          learning_id: expect.stringMatching(/^cdl-[a-f0-9]{16}$/u),
          // The same-day re-run rewrote the report: the candidate now stands.
          candidate: 'existing',
          has_suggested_default: false,
        }),
      ],
      overturns: expect.arrayContaining([
        expect.objectContaining({
          scope: 'template_entry',
          template_id: 'aidlc-inception',
          entry_id: 'retention',
          overturned: 1,
        }),
      ]),
    });
    const text = JSON.stringify(out);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    for (const field of [
      '"value"',
      'customer_values',
      'proposed_values',
      'current_org_default',
      'suggested_org_default',
    ])
      expect(text).not.toContain(field);
    await expect(
      run(['overview', '--tenant', TENANT, '--learning', '--date', '2026-01-01'])
    ).rejects.toThrow(/\[CUSTOMER_DECISION_REPORT_NOT_FOUND\]/u);
    await expect(
      run(['overview', '--tenant', TENANT, '--learning', '--date', '2026-13-40'])
    ).rejects.toThrow(/--date must be a date/u);
    await expect(
      run(['overview', '--tenant', TENANT, '--learning', '--case', CASE])
    ).rejects.toThrow(/--learning takes no --case/u);
    // Another tenant has no report of its own.
    const other = await run(['overview', '--tenant', OTHER, '--learning']);
    expect(other).toMatchObject({ tenant_slug: OTHER, report_date: null, available_dates: [] });
    expect(snapshot(STORES)).toEqual(before);
  }, 60_000);

  it('learning --install needs --by and promotes the weekly template into the tenant catalog', async () => {
    await expect(run(['learning', '--tenant', TENANT, '--install'])).rejects.toThrow(
      /--by user:<member> is required/u
    );
    const out = await run(['learning', '--tenant', TENANT, '--install', '--by', 'user:ops-lead']);
    expect(out).toMatchObject({
      installed: `knowledge/confidential/${TENANT}/pipelines/customer-decision-learning.json`,
      dry_run: false,
    });
    const installed = JSON.parse(
      initialContext('ecosystem_architect', () =>
        String(io.safeReadFile(path.join(ROOT, String(out.installed)), { encoding: 'utf8' }))
      )
    ) as { steps: Array<{ op: string }>; schedule: { id: string; cron: string } };
    expect(installed.steps.map((item) => item.op)).toEqual(['core:customer_decision_learning']);
    expect(installed.schedule).toMatchObject({
      id: 'customer-decision-learning',
      cron: '0 9 * * 1',
    });
  }, 60_000);

  it.skipIf(STALE_DIST !== null)(
    `the weekly op runs the facade as a child bound to its tenant, and refuses another tenant${STALE_DIST ? ` (skipped: ${STALE_DIST} — run pnpm -s build)` : ''}`,
    async () => {
      const { runCustomerDecisionLearningOp } = await import('./customer-decision/learning-op.js');
      const { buildTenantRunEnv } = await import('./chronos_daemon.js');
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
        const scriptPath = path.join(SOURCE_ROOT, 'dist/scripts/customer_decision.js');
        const dry = await runCustomerDecisionLearningOp({ dryRun: true, now: NOW, scriptPath });
        expect(dry).toMatchObject({
          tenant: TENANT,
          dry_run: true,
          report_date: REPORT_DATE,
          cases: 2,
          case_failures: 0,
          suggestions: 1,
          created: 0,
        });
        expect(dry.learning_ids).toHaveLength(1);
        // A real run in the child: the candidate already exists.
        const real = await runCustomerDecisionLearningOp({ now: NOW, scriptPath });
        expect(real).toMatchObject({
          dry_run: false,
          created: 0,
          existing: 1,
          // The weekly default window: the last 90 days.
          since: '2026-07-26T00:00:00.000Z',
        });
        await expect(
          runCustomerDecisionLearningOp({ tenant: OTHER, now: NOW, scriptPath })
        ).rejects.toThrow(/TENANT_MISMATCH/u);
      } finally {
        for (const key of keys) delete process.env[key];
      }
      await expect(runCustomerDecisionLearningOp({ now: NOW })).rejects.toThrow(/TENANT_REQUIRED/u);
    },
    120_000
  );
});
