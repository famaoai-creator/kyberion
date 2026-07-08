import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E2E-06 Task 8: customer dialogue end-to-end.
 *
 * Covers the flow 問い合わせ → カタログ準拠回答 → (範囲外は確認して戻す+エスカレーション)
 * → 決定論見積 → 承認ゲート付き送付 → 商談ステージ前進、and the four defense
 * layers the plan says must never be weakened:
 *   1. catalog/price-book 外は「確認して戻す」構造
 *   2. 能動送信は approval gate のみ (sendToCustomer)
 *   3. (contract review — residual, see plan 実装状況)
 *   4. 顧客入力は非信頼 (プロンプトに明記)
 */

const realFsSecureIo = vi.hoisted(() => ({
  safeAppendFileSync: (filePath: string, data: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, data, 'utf8');
  },
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeMkdir: (dirPath: string, options?: { recursive?: boolean }) =>
    fs.mkdirSync(dirPath, { recursive: options?.recursive !== false }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  safeReaddir: (dirPath: string) => fs.readdirSync(dirPath),
  safeStat: (filePath: string) => fs.statSync(filePath),
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
}));

vi.mock('../libs/core/secure-io.js', () => realFsSecureIo);

vi.mock('../libs/core/core.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const backendPrompt = vi.hoisted(() => vi.fn());
const backendExtractRequirements = vi.hoisted(() => vi.fn());
vi.mock('../libs/core/reasoning-backend.js', () => ({
  getReasoningBackend: () => ({
    name: 'claude-agent',
    prompt: backendPrompt,
    extractRequirements: backendExtractRequirements,
  }),
}));

const opsAlerts = vi.hoisted(() => vi.fn());
vi.mock('../libs/core/ops-alert.js', () => ({ sendOpsAlert: opsAlerts }));

const gate = vi.hoisted(() => vi.fn());
vi.mock('../libs/core/approval-gate.js', () => ({ enforceApprovalGate: gate }));

const notify = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../libs/core/operator-notifications.js', () => ({ notifyOperator: notify }));

const memoryQueue = vi.hoisted(() => ({
  create: vi.fn((input: Record<string, unknown>) => ({ candidate_id: 'MEM-TEST-1', ...input })),
  enqueue: vi.fn(() => 'queued'),
}));
vi.mock('../libs/core/memory-promotion-queue.js', () => ({
  createMemoryPromotionCandidate: memoryQueue.create,
  enqueueMemoryPromotionCandidate: memoryQueue.enqueue,
}));

const SLUG = 'e2e06-fixture-tenant';
const CHANNEL = 'C_E2E06_FIXTURE';

let tmpRoot: string;
let core: typeof import('../libs/core/customer-conversation.js') &
  typeof import('../libs/core/customer-channel-binding.js') &
  typeof import('../libs/core/deal-store.js') &
  typeof import('../libs/core/deal-documents.js');

describe('customer dialogue (E2E-06)', () => {
  beforeAll(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-e2e06-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    process.env.KYBERION_ROOT = tmpRoot;

    // fixture tenant binding
    const bindingsPath = path.join(
      tmpRoot,
      'customer',
      SLUG,
      'connections',
      'channel-bindings.json'
    );
    fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
    fs.writeFileSync(
      bindingsPath,
      JSON.stringify({
        bindings: [
          {
            surface: 'slack',
            channel_id: CHANNEL,
            counterpart: { name: '山田様', org: 'ACME' },
            language: 'ja',
            disclosure_level: 'public_catalog_only',
            active: true,
          },
          { surface: 'slack', channel_id: 'C_INACTIVE', active: false },
        ],
      })
    );
    // underscore-prefixed dirs (e.g. _template) must be ignored
    fs.mkdirSync(path.join(tmpRoot, 'customer', '_template', 'connections'), { recursive: true });

    // grounding fixtures
    const catalogPath = path.join(tmpRoot, 'knowledge', 'public', 'sales', 'solution-catalog.json');
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({ version: '1.0.0', solutions: [{ id: 'kyberion-work-automation' }] })
    );
    const priceBookPath = path.join(tmpRoot, 'knowledge', 'product', 'sales', 'price-book.json');
    fs.mkdirSync(path.dirname(priceBookPath), { recursive: true });
    fs.writeFileSync(
      priceBookPath,
      JSON.stringify({
        version: '1.0.0',
        currency: 'JPY',
        items: [
          { sku: 'ENG-HOUR', name: 'eng', unit: 'hour', unit_price: 15000 },
          { sku: 'CREATIVE-HOUR', name: 'creative', unit: 'hour', unit_price: 12000 },
        ],
        estimate_rules: [
          {
            task_kind: 'feature_addition',
            base_hours: 24,
            rate_sku: 'ENG-HOUR',
            size_multipliers: { S: 0.5, M: 1, L: 2.5 },
          },
          {
            task_kind: 'document_production',
            base_hours: 8,
            rate_sku: 'CREATIVE-HOUR',
            size_multipliers: { S: 0.5, M: 1, L: 2 },
          },
        ],
      })
    );

    // second tenant with confidential sales notes for the isolation assert
    const otherNotes = path.join(
      tmpRoot,
      'knowledge',
      'confidential',
      'other-tenant',
      'sales',
      'notes.md'
    );
    fs.mkdirSync(path.dirname(otherNotes), { recursive: true });
    fs.writeFileSync(otherNotes, 'OTHER-TENANT-SECRET-PRICING-MEMO');
    const otherBindings = path.join(
      tmpRoot,
      'customer',
      'other-tenant',
      'connections',
      'channel-bindings.json'
    );
    fs.mkdirSync(path.dirname(otherBindings), { recursive: true });
    fs.writeFileSync(
      otherBindings,
      JSON.stringify({ bindings: [{ surface: 'slack', channel_id: 'C_OTHER', active: true }] })
    );
    // contract template fixture
    const templatePath = path.join(
      tmpRoot,
      'knowledge',
      'product',
      'sales',
      'contract-templates',
      'basic-service-agreement.md'
    );
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.writeFileSync(
      templatePath,
      '# 契約書 {{DATE}}\n範囲:\n{{SCOPE}}\n金額: {{AMOUNT}} {{CURRENCY}}\n検収: {{SUCCESS_CONDITION}}\n見積: {{QUOTE_REF}}\n'
    );

    const conversation = await import('../libs/core/customer-conversation.js');
    const bindingMod = await import('../libs/core/customer-channel-binding.js');
    const dealMod = await import('../libs/core/deal-store.js');
    const docsMod = await import('../libs/core/deal-documents.js');
    core = { ...conversation, ...bindingMod, ...dealMod, ...docsMod } as typeof core;
  });

  afterAll(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  beforeEach(() => {
    backendPrompt.mockReset();
    backendExtractRequirements.mockReset();
    opsAlerts.mockReset();
    gate.mockReset();
    notify.mockClear();
    memoryQueue.create.mockClear();
    memoryQueue.enqueue.mockClear();
  });

  it('resolves bound channels, ignores inactive bindings and unbound channels', () => {
    const bound = core.resolveCustomerBinding('slack', CHANNEL);
    expect(bound?.tenantSlug).toBe(SLUG);
    expect(bound?.binding.counterpart?.org).toBe('ACME');
    expect(core.resolveCustomerBinding('slack', 'C_INACTIVE')).toBeNull();
    expect(core.resolveCustomerBinding('slack', 'C_NOT_BOUND')).toBeNull();
    expect(core.resolveCustomerBinding('telegram', CHANNEL)).toBeNull();
  });

  it('answers a grounded inquiry: opens a deal, records both notes, cites sources', async () => {
    backendPrompt.mockResolvedValue('Kyberion はミッション単位で業務を自動化します。');
    const binding = core.resolveCustomerBinding('slack', CHANNEL)!;
    const result = await core.runCustomerConversation({
      binding,
      text: 'どんなことができますか?',
    });

    expect(result.escalated).toBe(false);
    expect(result.text).toContain('自動化');
    expect(result.grounded_sources).toContain('solution-catalog');
    expect(result.grounded_sources).toContain('price-book');
    expect(result.deal.stage).toBe('inquiry');

    const stored = core.getDeal(SLUG, result.deal.deal_id)!;
    expect(stored.notes.map((n) => n.role)).toEqual(['customer', 'kyberion']);

    // defense layer 4: customer input is declared untrusted in the prompt
    const prompt = backendPrompt.mock.calls[0][0] as string;
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('DISCLOSURE POLICY');

    // continuity: the next message reuses the same deal
    backendPrompt.mockResolvedValue('続きですね。');
    const second = await core.runCustomerConversation({ binding, text: '昨日の続きです' });
    expect(second.deal.deal_id).toBe(result.deal.deal_id);
  });

  it('escalates out-of-catalog questions: hold reply + ops alert, marker never leaks', async () => {
    backendPrompt.mockResolvedValue(
      '確認して回答します。 [NEEDS_OPERATOR] 競合他社比較の可否をオペレーターが判断'
    );
    const binding = core.resolveCustomerBinding('slack', CHANNEL)!;
    const result = await core.runCustomerConversation({
      binding,
      text: '競合のX社と比べてどうですか?',
    });

    expect(result.escalated).toBe(true);
    expect(result.text).not.toContain('[NEEDS_OPERATOR]');
    expect(result.text).toContain('確認して回答します');
    expect(opsAlerts).toHaveBeenCalledTimes(1);
    const alert = opsAlerts.mock.calls[0][0];
    expect(alert.severity).toBe('warning');
    expect(alert.dedupe_key).toContain(result.deal.deal_id);
  });

  it('escalates on backend failure instead of improvising', async () => {
    backendPrompt.mockRejectedValue(new Error('backend down'));
    const binding = core.resolveCustomerBinding('slack', CHANNEL)!;
    const result = await core.runCustomerConversation({ binding, text: '見積をください' });
    expect(result.escalated).toBe(true);
    expect(result.text).toContain('確認して回答します');
    expect(opsAlerts).toHaveBeenCalledTimes(1);
  });

  it('builds quotes deterministically from the price book; unknown work is unquotable', () => {
    const priceBook = core.loadPriceBook(SLUG)!;
    expect(priceBook.currency).toBe('JPY');

    const quote = core.buildQuoteFromPriceBook(
      [
        { task_kind: 'feature_addition', size: 'M', description: '機能追加' },
        { task_kind: 'document_production', size: 'S' },
      ],
      priceBook
    );
    expect(quote.ok).toBe(true);
    expect(quote.lines[0].amount).toBe(24 * 15000);
    expect(quote.lines[1].amount).toBe(4 * 12000);
    expect(quote.total).toBe(24 * 15000 + 4 * 12000);

    const bad = core.buildQuoteFromPriceBook([{ task_kind: 'quantum_reactor' }], priceBook);
    expect(bad.ok).toBe(false);
    expect(bad.unquotable[0]).toEqual({ task_kind: 'quantum_reactor', reason: 'no_estimate_rule' });
  });

  it('deal stages move forward only; rewind requires operator; refs and missions attach', () => {
    const deal = core.openDeal({
      tenantSlug: SLUG,
      surface: 'slack',
      channelId: 'C_STAGE_TEST',
      summary: 'stage machine test',
    });
    core.advanceDealStage({ tenantSlug: SLUG, dealId: deal.deal_id, stage: 'qualified' });
    const quoted = core.advanceDealStage({
      tenantSlug: SLUG,
      dealId: deal.deal_id,
      stage: 'quote',
      refs: { quote_ref: 'quotes/Q-1.json' },
    });
    expect(quoted.stage).toBe('quote');
    expect(quoted.quote_ref).toBe('quotes/Q-1.json');

    expect(() =>
      core.advanceDealStage({ tenantSlug: SLUG, dealId: deal.deal_id, stage: 'inquiry' })
    ).toThrow(/deal_stage_rewind_requires_operator/);

    const rewound = core.advanceDealStage({
      tenantSlug: SLUG,
      dealId: deal.deal_id,
      stage: 'discovery',
      operator: true,
    });
    expect(rewound.stage).toBe('discovery');

    const won = core.advanceDealStage({
      tenantSlug: SLUG,
      dealId: deal.deal_id,
      stage: 'won',
      agreed: { scope: ['機能A'], amount: { value: 360000, currency: 'JPY' } },
      missionId: 'MSN-42',
    });
    expect(won.agreed?.amount?.value).toBe(360000);
    expect(won.mission_ids).toContain('MSN-42');

    const lost = core.advanceDealStage({ tenantSlug: SLUG, dealId: deal.deal_id, stage: 'lost' });
    expect(lost.stage).toBe('lost');
  });

  it('sendToCustomer is approval-gated: pending blocks delivery, approval delivers', async () => {
    const binding = core.resolveCustomerBinding('slack', CHANNEL)!;
    const deliver = vi.fn().mockResolvedValue(undefined);

    gate.mockReturnValue({ allowed: false, status: 'pending', requestId: 'APR-1' });
    const pending = await core.sendToCustomer({
      binding,
      title: 'お見積り',
      body: '合計 408,000 JPY',
      deliver,
    });
    expect(pending.sent).toBe(false);
    expect(pending.status).toBe('approval_pending');
    expect(pending.approvalRequestId).toBe('APR-1');
    expect(deliver).not.toHaveBeenCalled();
    // the gate is invoked with the customer:outbound intent (policy fail-closed)
    expect(gate.mock.calls[0][0].intentId).toBe('customer:outbound');

    gate.mockReturnValue({ allowed: true, status: 'approved' });
    const sent = await core.sendToCustomer({
      binding,
      title: 'お見積り',
      body: '合計 408,000 JPY',
      deliver,
    });
    expect(sent).toEqual({ sent: true, status: 'sent' });
    expect(deliver).toHaveBeenCalledTimes(1);

    gate.mockReturnValue({ allowed: true, status: 'approved' });
    const failed = await core.sendToCustomer({
      binding,
      title: 'お見積り',
      body: '合計 408,000 JPY',
      deliver: vi.fn().mockRejectedValue(new Error('slack down')),
    });
    expect(failed.status).toBe('delivery_failed');
  });

  it('never leaks another tenant into the grounding prompt (会話面の tier-guard)', async () => {
    backendPrompt.mockResolvedValue('カタログの範囲でお答えします。');
    const binding = core.resolveCustomerBinding('slack', CHANNEL)!;
    await core.runCustomerConversation({ binding, text: '価格を教えてください' });
    const prompt = backendPrompt.mock.calls[0][0] as string;
    expect(prompt).not.toContain('OTHER-TENANT-SECRET-PRICING-MEMO');
    expect(prompt).not.toContain('other-tenant');
  });

  it('generates a versioned quote from the price book and notifies for approval', () => {
    const deal = core.openDeal({
      tenantSlug: SLUG,
      surface: 'slack',
      channelId: 'C_QUOTE_DOC',
      summary: '機能追加の見積依頼',
    });
    const result = core.generateQuoteForDeal({
      tenantSlug: SLUG,
      dealId: deal.deal_id,
      requests: [{ task_kind: 'feature_addition', size: 'M', description: '機能追加' }],
    });
    expect(result.ok).toBe(true);
    expect(result.quote!.total).toBe(24 * 15000);
    expect(result.deal!.stage).toBe('quote');
    expect(result.deal!.quote_ref).toContain(`${deal.deal_id}/quote-v1.md`);
    const md = fs.readFileSync(path.join(tmpRoot, result.quote_ref!), 'utf8');
    expect(md).toContain('360,000');
    const approvalNotify = notify.mock.calls.find((call) => call[0] === 'approval_required');
    expect(approvalNotify).toBeTruthy();

    // unquotable work goes to the operator and never advances the stage
    const bad = core.generateQuoteForDeal({
      tenantSlug: SLUG,
      dealId: deal.deal_id,
      requests: [{ task_kind: 'quantum_reactor' }],
    });
    expect(bad.ok).toBe(false);
    expect(notify.mock.calls.some((call) => call[0] === 'question')).toBe(true);
    expect(core.getDeal(SLUG, deal.deal_id)!.stage).toBe('quote');
  });

  it('contracts require agreement to draft and an approved review to send (防御層③)', async () => {
    const deal = core.openDeal({
      tenantSlug: SLUG,
      surface: 'slack',
      channelId: 'C_CONTRACT_DOC',
      summary: '契約フローテスト',
    });
    expect(() => core.draftContractForDeal({ tenantSlug: SLUG, dealId: deal.deal_id })).toThrow(
      /contract_requires_agreement/
    );

    core.advanceDealStage({
      tenantSlug: SLUG,
      dealId: deal.deal_id,
      stage: 'quote',
      agreed: {
        scope: ['ログイン機能の追加'],
        amount: { value: 360000, currency: 'JPY' },
        success_condition: 'ログインできること',
      },
    });
    const drafted = core.draftContractForDeal({ tenantSlug: SLUG, dealId: deal.deal_id });
    expect(drafted.deal.stage).toBe('contract');
    const contractMd = fs.readFileSync(path.join(tmpRoot, drafted.contract_ref), 'utf8');
    expect(contractMd).toContain('ログイン機能の追加');
    expect(contractMd).toContain('360,000 JPY');

    const binding = core.resolveCustomerBinding('slack', CHANNEL)!;
    const deliver = vi.fn().mockResolvedValue(undefined);
    gate.mockReturnValue({ allowed: true, status: 'approved' });

    // no review record → structurally blocked, gate never reached
    const blocked = await core.sendDealDocumentToCustomer({
      binding,
      dealId: deal.deal_id,
      kind: 'contract',
      version: drafted.version,
      deliver,
    });
    expect(blocked.status).toBe('blocked');
    expect((blocked as { reason?: string }).reason).toBe('contract_review_required');
    expect(deliver).not.toHaveBeenCalled();

    core.recordContractReview({
      tenantSlug: SLUG,
      dealId: deal.deal_id,
      version: drafted.version,
      verdict: 'approve',
      reviewer: 'operator',
    });
    const sent = await core.sendDealDocumentToCustomer({
      binding,
      dealId: deal.deal_id,
      kind: 'contract',
      version: drafted.version,
      deliver,
    });
    expect(sent.status).toBe('sent');
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('won hands off to the SDLC with the customer words as the mission goal', () => {
    const deal = core.openDeal({
      tenantSlug: SLUG,
      surface: 'slack',
      channelId: 'C_SDLC_HANDOFF',
      summary: '顧客: 検索機能を追加してほしい',
    });
    core.advanceDealStage({
      tenantSlug: SLUG,
      dealId: deal.deal_id,
      stage: 'contract',
      agreed: { scope: ['検索機能の追加'], amount: { value: 360000, currency: 'JPY' } },
    });
    const handoff = core.handoffWonDealToSdlc({
      tenantSlug: SLUG,
      dealId: deal.deal_id,
      missionId: 'MSN-DEAL-1',
    });
    expect(handoff.sdlc_pipeline).toBe('pipelines/sdlc-cycle.json');
    expect(handoff.deal.stage).toBe('won');
    expect(handoff.deal.mission_ids).toContain('MSN-DEAL-1');
    const payload = JSON.parse(fs.readFileSync(handoff.handoff_path, 'utf8'));
    expect(payload.goal.summary).toBe('検索機能の追加');
    expect(payload.source_text).toContain('検索機能を追加してほしい');
  });

  it('won snapshots the agreement; delivered queues a distill candidate (還流)', () => {
    const deal = core.openDeal({
      tenantSlug: SLUG,
      surface: 'slack',
      channelId: 'C_DISTILL',
      summary: '納品まで完了した商談',
    });
    core.advanceDealStage({
      tenantSlug: SLUG,
      dealId: deal.deal_id,
      stage: 'won',
      agreed: { scope: ['成果物A'], amount: { value: 100000, currency: 'JPY' } },
    });
    const snapshot = path.join(
      tmpRoot,
      'customer',
      SLUG,
      'deals',
      deal.deal_id,
      'agreement-v1.json'
    );
    expect(fs.existsSync(snapshot)).toBe(true);
    expect(JSON.parse(fs.readFileSync(snapshot, 'utf8')).agreed.scope).toEqual(['成果物A']);

    core.advanceDealStage({ tenantSlug: SLUG, dealId: deal.deal_id, stage: 'delivering' });
    core.advanceDealStage({ tenantSlug: SLUG, dealId: deal.deal_id, stage: 'delivered' });
    expect(memoryQueue.enqueue).toHaveBeenCalledTimes(1);
    const candidate = memoryQueue.create.mock.calls[0][0];
    expect(candidate.sourceRef).toBe(`deal:${SLUG}/${deal.deal_id}`);
    expect(candidate.sensitivityTier).toBe('confidential');
  });

  it('discovery stage switches to requirements-hearing mode and captures a structured draft', async () => {
    const modes = await import('../libs/core/customer-conversation-modes.js');
    backendPrompt.mockResolvedValue('承知しました。まず成功条件を伺えますか?');
    backendExtractRequirements.mockResolvedValue({
      functional_requirements: [
        { id: 'FR-1', description: '日次レポート自動生成', priority: 'must' },
      ],
      non_functional_requirements: [],
      constraints: [],
      assumptions: [],
      open_questions: [{ question: '対象データソースは?', blocking: true, status: 'open' }],
    });

    const binding = core.resolveCustomerBinding('slack', CHANNEL)!;
    const first = await core.runCustomerConversation({ binding, text: '要件の相談をしたい' });
    core.advanceDealStage({ tenantSlug: SLUG, dealId: first.deal.deal_id, stage: 'qualified' });
    core.advanceDealStage({ tenantSlug: SLUG, dealId: first.deal.deal_id, stage: 'discovery' });

    const result = await core.runCustomerConversation({
      binding,
      text: 'レポート業務を自動化したい',
    });
    expect(result.mode).toBe('requirements_hearing');
    const prompt = backendPrompt.mock.calls.at(-1)![0] as string;
    expect(prompt).toContain('MODE: requirements hearing');
    expect(prompt).toContain('OPEN QUESTIONS');
    // disclosure policy survives mode switching
    expect(prompt).toContain('DISCLOSURE POLICY');

    await vi.waitFor(() => {
      const capture = modes.readDealRequirementsCapture(SLUG, result.deal.deal_id);
      expect(capture).toBeTruthy();
      expect(capture!.requirements.functional_requirements[0].id).toBe('FR-1');
    });

    // next hearing turn feeds prior draft + surfaces the blocking open question
    backendPrompt.mockResolvedValue('対象データソースを伺えますか?');
    await core.runCustomerConversation({ binding, text: '毎朝9時に欲しい' });
    const nextPrompt = backendPrompt.mock.calls.at(-1)![0] as string;
    expect(nextPrompt).toContain('[blocking] 対象データソースは?');
    await vi.waitFor(() => {
      expect(backendExtractRequirements.mock.calls.at(-1)![0].priorDraft).toBeTruthy();
    });
  });

  it('binding mode override forces support mode and grounds replies in known issues', async () => {
    const knownIssuesPath = path.join(
      tmpRoot,
      'knowledge',
      'confidential',
      SLUG,
      'support',
      'known-issues.md'
    );
    fs.mkdirSync(path.dirname(knownIssuesPath), { recursive: true });
    fs.writeFileSync(knownIssuesPath, '## KI-1: エクスポートが失敗する → 回避策: 再ログイン');

    backendPrompt.mockResolvedValue('既知の事象です。再ログインをお試しください。');
    const binding = core.resolveCustomerBinding('slack', CHANNEL)!;
    const overridden = {
      ...binding,
      binding: { ...binding.binding, mode: 'support' as const },
    };
    const result = await core.runCustomerConversation({
      binding: overridden,
      text: 'エクスポートができません',
    });
    expect(result.mode).toBe('support');
    expect(result.grounded_sources).toContain('known-issues');
    const prompt = backendPrompt.mock.calls.at(-1)![0] as string;
    expect(prompt).toContain('MODE: customer support');
    expect(prompt).toContain('KNOWN ISSUES');
    expect(prompt).toContain('再ログイン');
    // support mode never runs requirements capture
    expect(backendExtractRequirements).not.toHaveBeenCalled();
  });

  it('repo approval policy marks customer:outbound as approval-required', () => {
    const policyPath = path.resolve(
      __dirname,
      '../knowledge/product/governance/approval-policy.json'
    );
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      rules: Array<{ intent_ids?: string[]; requires_approval: boolean }>;
    };
    const rule = policy.rules.find((entry) => entry.intent_ids?.includes('customer:outbound'));
    expect(rule?.requires_approval).toBe(true);
  });
});
