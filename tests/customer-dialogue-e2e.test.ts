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
vi.mock('../libs/core/reasoning-backend.js', () => ({
  getReasoningBackend: () => ({ prompt: backendPrompt }),
}));

const opsAlerts = vi.hoisted(() => vi.fn());
vi.mock('../libs/core/ops-alert.js', () => ({ sendOpsAlert: opsAlerts }));

const gate = vi.hoisted(() => vi.fn());
vi.mock('../libs/core/approval-gate.js', () => ({ enforceApprovalGate: gate }));

const SLUG = 'e2e06-fixture-tenant';
const CHANNEL = 'C_E2E06_FIXTURE';

let tmpRoot: string;
let core: typeof import('../libs/core/customer-conversation.js') &
  typeof import('../libs/core/customer-channel-binding.js') &
  typeof import('../libs/core/deal-store.js');

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

    const conversation = await import('../libs/core/customer-conversation.js');
    const bindingMod = await import('../libs/core/customer-channel-binding.js');
    const dealMod = await import('../libs/core/deal-store.js');
    core = { ...conversation, ...bindingMod, ...dealMod } as typeof core;
  });

  afterAll(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  beforeEach(() => {
    backendPrompt.mockReset();
    opsAlerts.mockReset();
    gate.mockReset();
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
