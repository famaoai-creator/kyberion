import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import { logger } from './core.js';
import { notifyOperator } from './operator-notifications.js';
import { writeIntentGoalHandoff } from './intent-handoff.js';
import type { ResolvedCustomerBinding } from './customer-channel-binding.js';
import {
  advanceDealStage,
  appendDealNote,
  buildQuoteFromPriceBook,
  getDeal,
  loadPriceBook,
  type DealRecord,
  type QuoteLineRequest,
  type QuoteResult,
} from './deal-store.js';
import { sendToCustomer, type SendToCustomerResult } from './customer-conversation.js';

/**
 * E2E-06 Tasks 5/6: deal documents (quote / contract) and the SDLC handoff.
 *
 * Rules that must never be weakened:
 *  - quote math is buildQuoteFromPriceBook only (LLMs never do arithmetic);
 *    unknown work is unquotable → operator.
 *  - contracts CANNOT be sent until a contract-review record with an
 *    approve verdict exists for that exact version (defense layer 3).
 *  - every outbound send goes through sendToCustomer (approval gate).
 */

function dealDocsDir(tenantSlug: string, dealId: string): string {
  return pathResolver.rootResolve(path.join('customer', tenantSlug, 'deals', dealId));
}

function nextVersion(dir: string, prefix: string): number {
  if (!safeExistsSync(dir)) return 1;
  try {
    const versions = safeReaddir(dir)
      .map((entry) => entry.match(new RegExp(`^${prefix}-v(\\d+)\\.`)))
      .filter(Boolean)
      .map((match) => Number(match![1]));
    return versions.length > 0 ? Math.max(...versions) + 1 : 1;
  } catch {
    return 1;
  }
}

function renderQuoteMarkdown(deal: DealRecord, quote: QuoteResult, version: number): string {
  return [
    `# お見積書 (${deal.deal_id} v${version})`,
    '',
    `- 宛先: ${deal.channel.surface}:${deal.channel.channel_id}`,
    `- 通貨: ${quote.currency}`,
    '',
    '| 項目 | 作業種別 | 時間 | 単価 | 金額 |',
    '|---|---|---:|---:|---:|',
    ...quote.lines.map(
      (line) =>
        `| ${line.description} | ${line.task_kind} | ${line.hours}h | ${line.unit_price.toLocaleString()} | ${line.amount.toLocaleString()} |`
    ),
    '',
    `**合計: ${quote.total.toLocaleString()} ${quote.currency}(税別)**`,
    '',
    '> 金額は price book の決定論ルールで算出されています。',
  ].join('\n');
}

export interface GenerateQuoteResult {
  ok: boolean;
  version?: number;
  quote_ref?: string;
  quote?: QuoteResult;
  deal?: DealRecord;
  unquotable?: QuoteResult['unquotable'];
}

export function generateQuoteForDeal(input: {
  tenantSlug: string;
  dealId: string;
  requests: QuoteLineRequest[];
}): GenerateQuoteResult {
  const deal = getDeal(input.tenantSlug, input.dealId);
  if (!deal) throw new Error(`deal_not_found:${input.dealId}`);
  const priceBook = loadPriceBook(input.tenantSlug);
  if (!priceBook) throw new Error('price_book_missing');
  const quote = buildQuoteFromPriceBook(input.requests, priceBook);
  if (!quote.ok) {
    // Unknown work never gets an invented price — it goes to the operator.
    void notifyOperator('question', {
      title: `見積不能項目あり (${input.tenantSlug} / ${deal.deal_id})`,
      body: quote.unquotable.map((entry) => `- ${entry.task_kind}: ${entry.reason}`).join('\n'),
      correlation_id: `${deal.deal_id}:unquotable`,
    });
    return { ok: false, unquotable: quote.unquotable };
  }
  const dir = dealDocsDir(input.tenantSlug, input.dealId);
  safeMkdir(dir, { recursive: true });
  const version = nextVersion(dir, 'quote');
  const quoteRef = path.join(
    'customer',
    input.tenantSlug,
    'deals',
    input.dealId,
    `quote-v${version}.md`
  );
  safeWriteFile(path.join(dir, `quote-v${version}.json`), JSON.stringify(quote, null, 2));
  safeWriteFile(path.join(dir, `quote-v${version}.md`), renderQuoteMarkdown(deal, quote, version));
  const advanced = advanceDealStage({
    tenantSlug: input.tenantSlug,
    dealId: input.dealId,
    stage: 'quote',
    evidence: quoteRef,
    refs: { quote_ref: quoteRef },
  });
  void notifyOperator('approval_required', {
    title: `見積書ドラフト完成 (${deal.deal_id} v${version})`,
    body: `合計 ${quote.total.toLocaleString()} ${quote.currency}。送付には承認が必要です。`,
    link_hint: quoteRef,
    correlation_id: `${deal.deal_id}:quote-v${version}`,
  });
  return { ok: true, version, quote_ref: quoteRef, quote, deal: advanced };
}

const DEFAULT_CONTRACT_TEMPLATE = 'product/sales/contract-templates/basic-service-agreement.md';

export function draftContractForDeal(input: {
  tenantSlug: string;
  dealId: string;
  templatePath?: string;
}): { version: number; contract_ref: string; deal: DealRecord } {
  const deal = getDeal(input.tenantSlug, input.dealId);
  if (!deal) throw new Error(`deal_not_found:${input.dealId}`);
  if (!deal.agreed?.scope?.length || !deal.agreed.amount) {
    throw new Error('contract_requires_agreement: record agreed scope and amount first');
  }
  const templateFile = pathResolver.knowledge(input.templatePath || DEFAULT_CONTRACT_TEMPLATE);
  if (!safeExistsSync(templateFile)) throw new Error(`contract_template_missing:${templateFile}`);
  const template = String(safeReadFile(templateFile, { encoding: 'utf8' }));
  const rendered = template
    .split('{{DATE}}')
    .join(new Date().toISOString().slice(0, 10))
    .split('{{CUSTOMER_NAME}}')
    .join('(担当者名)')
    .split('{{CUSTOMER_ORG}}')
    .join('(発注者名)')
    .split('{{SCOPE}}')
    .join(deal.agreed.scope.map((entry) => `- ${entry}`).join('\n'))
    .split('{{AMOUNT}}')
    .join(deal.agreed.amount.value.toLocaleString())
    .split('{{CURRENCY}}')
    .join(deal.agreed.amount.currency)
    .split('{{DUE_DATE}}')
    .join(deal.agreed.due_date || '(個別契約で定める)')
    .split('{{SUCCESS_CONDITION}}')
    .join(deal.agreed.success_condition || '(検収条件を個別契約で定める)')
    .split('{{QUOTE_REF}}')
    .join(deal.quote_ref || '(未発行)');
  const dir = dealDocsDir(input.tenantSlug, input.dealId);
  safeMkdir(dir, { recursive: true });
  const version = nextVersion(dir, 'contract');
  const contractRef = path.join(
    'customer',
    input.tenantSlug,
    'deals',
    input.dealId,
    `contract-v${version}.md`
  );
  safeWriteFile(path.join(dir, `contract-v${version}.md`), rendered);
  const advanced = advanceDealStage({
    tenantSlug: input.tenantSlug,
    dealId: input.dealId,
    stage: 'contract',
    evidence: contractRef,
    refs: { contract_ref: contractRef },
  });
  void notifyOperator('approval_required', {
    title: `契約書ドラフト完成 (${deal.deal_id} v${version})`,
    body: 'contract-review パイプラインのレビュー記録(approve)が無い限り送付できません。',
    link_hint: contractRef,
    correlation_id: `${deal.deal_id}:contract-v${version}`,
  });
  return { version, contract_ref: contractRef, deal: advanced };
}

/**
 * Defense layer 3: the review record. Written by the operator (or the
 * contract-review pipeline's closing step) after multi-perspective review.
 */
export function recordContractReview(input: {
  tenantSlug: string;
  dealId: string;
  version: number;
  verdict: 'approve' | 'reject';
  reviewer: string;
  notes?: string;
}): string {
  const dir = dealDocsDir(input.tenantSlug, input.dealId);
  safeMkdir(dir, { recursive: true });
  const filePath = path.join(dir, `contract-review-v${input.version}.json`);
  safeWriteFile(
    filePath,
    JSON.stringify(
      {
        kind: 'contract-review-record',
        deal_id: input.dealId,
        version: input.version,
        verdict: input.verdict,
        reviewer: input.reviewer,
        notes: input.notes || '',
        reviewed_at: new Date().toISOString(),
      },
      null,
      2
    )
  );
  return filePath;
}

function contractReviewApproved(tenantSlug: string, dealId: string, version: number): boolean {
  const filePath = path.join(dealDocsDir(tenantSlug, dealId), `contract-review-v${version}.json`);
  try {
    if (!safeExistsSync(filePath)) return false;
    const record = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as {
      verdict?: string;
    };
    return record.verdict === 'approve';
  } catch {
    return false;
  }
}

export type SendDealDocumentResult =
  | SendToCustomerResult
  | { sent: false; status: 'blocked'; reason: string };

/**
 * The only path for sending quote/contract documents. Contracts additionally
 * require an approved contract-review record for the exact version.
 */
export async function sendDealDocumentToCustomer(input: {
  binding: ResolvedCustomerBinding;
  dealId: string;
  kind: 'quote' | 'contract';
  version: number;
  deliver: (text: string) => Promise<unknown>;
}): Promise<SendDealDocumentResult> {
  const tenantSlug = input.binding.tenantSlug;
  const docPath = path.join(
    dealDocsDir(tenantSlug, input.dealId),
    `${input.kind}-v${input.version}.md`
  );
  if (!safeExistsSync(docPath)) {
    return {
      sent: false,
      status: 'blocked',
      reason: `document_missing:${input.kind}-v${input.version}`,
    };
  }
  if (
    input.kind === 'contract' &&
    !contractReviewApproved(tenantSlug, input.dealId, input.version)
  ) {
    logger.warn(
      `[deal-documents] contract send blocked for ${input.dealId} v${input.version}: no approved review record`
    );
    return { sent: false, status: 'blocked', reason: 'contract_review_required' };
  }
  const body = String(safeReadFile(docPath, { encoding: 'utf8' }));
  const result = await sendToCustomer({
    binding: input.binding,
    title: `${input.kind === 'quote' ? 'お見積書' : '契約書ドラフト'} (${input.dealId} v${input.version})`,
    body,
    correlationId: `${input.dealId}:${input.kind}-v${input.version}`,
    deliver: input.deliver,
  });
  if (result.sent) {
    appendDealNote({
      tenantSlug,
      dealId: input.dealId,
      role: 'kyberion',
      text: `${input.kind}-v${input.version} を送付しました (sent_at: ${new Date().toISOString()})`,
    });
  }
  return result;
}

/**
 * E2E-06 Task 6: won → SDLC. The customer's words become the mission goal
 * via the IL-01 intent handoff; sdlc-cycle.json is the next pipeline to run
 * with this mission.
 */
export function handoffWonDealToSdlc(input: {
  tenantSlug: string;
  dealId: string;
  missionId: string;
}): { handoff_path: string; sdlc_pipeline: string; deal: DealRecord } {
  const deal = getDeal(input.tenantSlug, input.dealId);
  if (!deal) throw new Error(`deal_not_found:${input.dealId}`);
  if (!deal.agreed?.scope?.length) {
    throw new Error('sdlc_handoff_requires_agreement');
  }
  const handoffPath = writeIntentGoalHandoff(input.missionId, {
    source_text: deal.summary,
    correlation_id: deal.deal_id,
    goal: {
      summary: deal.agreed.scope.join(' / '),
      ...(deal.agreed.success_condition
        ? { success_condition: deal.agreed.success_condition }
        : {}),
    },
  });
  const advanced = advanceDealStage({
    tenantSlug: input.tenantSlug,
    dealId: input.dealId,
    stage: 'won',
    evidence: handoffPath,
    missionId: input.missionId,
  });
  return { handoff_path: handoffPath, sdlc_pipeline: 'pipelines/sdlc-cycle.json', deal: advanced };
}
