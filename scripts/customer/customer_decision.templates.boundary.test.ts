import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from '@agent/core/authority';
import { rootDir } from '@agent/core/path-resolver';
import * as initialIO from '@agent/core/secure-io';

/**
 * HR-01 tenant hearing templates on a fresh fixture root, through the real
 * paths: `template put / list / show` write and read
 * knowledge/confidential/<tenant>/decisions/_templates/, and `draft` uses the
 * tenant's template before the product one. Only the reasoning bootstrap is
 * disabled.
 */
vi.mock('@agent/core/reasoning/reasoning-bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/reasoning/reasoning-bootstrap')>()),
  installReasoningBackendsForService: vi.fn(() => false),
}));

const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/cd-templates-boundary-' + process.pid);
const TENANT = 'cd-templates-a';
const OTHER = 'cd-templates-b';
const NOW = '2026-11-13T00:00:00.000Z';
const keys = [
  'KYBERION_BASE_ROLE',
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

let facade: typeof import('./customer_decision.js');
let io: typeof import('@agent/core/secure-io');
let core: typeof import('@agent/core/customer-decision');

const TEMPLATE = {
  version: '1.0.0',
  template_id: 'aidlc-inception',
  phase: 'tenant_review',
  title: { ja: '要件レビュー', en: 'Requirements review' },
  objective: {
    statement: { ja: '現場の実務フローに合うかを確かめる', en: 'Check it fits the real work' },
    success_criteria: [{ ja: '承認フローが確定している', en: 'The approval flow is agreed' }],
  },
  entries: [
    {
      entry_id: 'approval_flow',
      item: 'FLOW',
      key: 'approval.flow',
      kind: 'hearing',
      question: { ja: '申請承認は何段階ですか？', en: 'How many approval steps?' },
      background: { ja: '現行は紙で回しています', en: 'Paper today' },
      requires_customer: false,
    },
  ],
};

function writeFixtureJson(relative: string, value: unknown): string {
  const file = path.join(ROOT, relative);
  io.safeWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"cd-templates-fixture"}');
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
    copy('knowledge/public/common');
    initialIO.safeMkdir(path.join(ROOT, 'active/shared/runtime'), { recursive: true });
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('@agent/core/secure-io');
  core = await import('@agent/core/customer-decision');
  facade = await import('./customer_decision.js');
  expect((await import('@agent/core/path-resolver')).rootDir()).toBe(ROOT);
  for (const key of keys) delete process.env[key];
  process.env.KYBERION_BASE_ROLE = 'sovereign';
  initialContext('ecosystem_architect', () => {
    for (const tenant of [TENANT, OTHER]) {
      writeFixtureJson(`knowledge/personal/tenants/${tenant}.json`, {
        tenant_slug: tenant,
        display_name: tenant,
        status: 'active',
        assigned_role: 'owner',
      });
    }
    writeFixtureJson('active/shared/tmp/hr01/template.json', TEMPLATE);
    writeFixtureJson('active/shared/tmp/hr01/reserved.json', {
      ...TEMPLATE,
      template_id: 'bolt-review',
    });
    writeFixtureJson('active/shared/tmp/hr01/invalid.json', {
      ...TEMPLATE,
      entries: [{ ...TEMPLATE.entries[0], question_key: 'customer_decision:x_question' }],
    });
  });
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
const run = (argv: string[]) => facade.runCustomerDecision(argv, { now: () => NOW });
const fixture = (name: string) => path.join(ROOT, 'active/shared/tmp/hr01', name);

describe('customer-decision tenant templates (HR-01, real paths)', () => {
  it('puts a tenant template under decisions/_templates/', async () => {
    const out = (await run([
      'template',
      'put',
      '--tenant',
      TENANT,
      '--file',
      fixture('template.json'),
      '--by',
      'user:alice',
    ])) as Out;
    expect(out).toMatchObject({
      template_id: 'aidlc-inception',
      origin: 'tenant',
      entries: 1,
      has_objective: true,
    });
    expect(path.relative(ROOT, String(out.path))).toBe(
      `knowledge/confidential/${TENANT}/decisions/_templates/aidlc-inception.json`
    );
  });

  it("lists and shows the tenant's template only for that tenant", async () => {
    const mine = (await run(['template', 'list', '--tenant', TENANT])) as { templates: Out[] };
    expect(mine.templates).toContainEqual({
      template_id: 'aidlc-inception',
      origin: 'tenant',
      shadows_product: true,
    });
    const theirs = (await run(['template', 'list', '--tenant', OTHER])) as { templates: Out[] };
    expect(theirs.templates).toContainEqual({
      template_id: 'aidlc-inception',
      origin: 'product',
      shadows_product: false,
    });
    const shown = (await run([
      'template',
      'show',
      '--tenant',
      OTHER,
      '--template',
      'aidlc-inception',
    ])) as { origin: string; template: Out };
    expect(shown.origin).toBe('product');
    expect(shown.template.phase).not.toBe('tenant_review');
  });

  it("drafts from the tenant's template, objective included", async () => {
    const drafted = (await run([
      'draft',
      '--tenant',
      TENANT,
      '--case',
      'case-hr01',
      '--customer',
      'acme',
      '--locale',
      'ja',
    ])) as { agenda_id: string; has_objective?: boolean };
    expect(drafted.has_objective).toBe(true);
    const agenda = initialContext(
      'decision_ledger',
      () => core.readAgenda({ tenantSlug: TENANT, caseId: 'case-hr01' }, drafted.agenda_id),
      undefined,
      TENANT
    );
    expect(agenda).toMatchObject({
      title: '要件レビュー',
      phase: 'tenant_review',
      objective: {
        statement: '現場の実務フローに合うかを確かめる',
        success_criteria: ['承認フローが確定している'],
      },
    });
    expect(agenda?.entries.map((entry) => entry.question)).toEqual(['申請承認は何段階ですか？']);
    // The template directory is never a case.
    expect(
      initialContext('decision_ledger', () => core.listTenantCaseIds(TENANT), undefined, TENANT)
    ).toEqual(['case-hr01']);
  });

  it('refuses a locale the template has no text for', async () => {
    const jaOnly = {
      ...TEMPLATE,
      template_id: 'ja-only',
      title: { ja: '日本語のみ' },
    };
    initialContext('ecosystem_architect', () =>
      writeFixtureJson('active/shared/tmp/hr01/ja-only.json', jaOnly)
    );
    await run([
      'template',
      'put',
      '--tenant',
      TENANT,
      '--file',
      fixture('ja-only.json'),
      '--by',
      'user:alice',
    ]);
    await expect(
      run([
        'draft',
        '--tenant',
        TENANT,
        '--case',
        'case-hr01-en',
        '--customer',
        'acme',
        '--template',
        'ja-only',
        '--locale',
        'en',
      ])
    ).rejects.toThrow(/TEMPLATE_LOCALE_MISSING/u);
  });

  it('refuses the reserved, the invalid and a mismatched id', async () => {
    const put = (file: string, extra: string[] = []) =>
      run([
        'template',
        'put',
        '--tenant',
        TENANT,
        '--file',
        fixture(file),
        '--by',
        'user:alice',
        ...extra,
      ]);
    await expect(put('reserved.json')).rejects.toThrow(/TEMPLATE_RESERVED/u);
    await expect(put('invalid.json')).rejects.toThrow(/does not match/u);
    await expect(put('template.json', ['--template', 'other'])).rejects.toThrow(
      /TEMPLATE_ID_MISMATCH/u
    );
    await expect(
      run(['template', 'put', '--tenant', TENANT, '--file', fixture('template.json')])
    ).rejects.toThrow(/--by/u);
  });

  it('refuses a tenant other than the bound one', async () => {
    process.env.KYBERION_TENANT = OTHER;
    try {
      await expect(
        run([
          'template',
          'put',
          '--tenant',
          TENANT,
          '--file',
          fixture('template.json'),
          '--by',
          'user:alice',
        ])
      ).rejects.toThrow(/TENANT_MISMATCH/u);
      await expect(run(['template', 'list', '--tenant', TENANT])).rejects.toThrow(
        /TENANT_MISMATCH/u
      );
    } finally {
      delete process.env.KYBERION_TENANT;
    }
  });
});
