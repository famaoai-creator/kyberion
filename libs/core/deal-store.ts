import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import type { ResolvedCustomerBinding } from './customer-channel-binding.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
} from './memory-promotion-queue.js';

/**
 * E2E-06 Task 4: the deal state machine — the persistent spine of a customer
 * engagement. Conversations come and go; the deal carries stage, lead score,
 * agreements and mission links across them.
 */

export type DealStage =
  | 'inquiry'
  | 'qualified'
  | 'discovery'
  | 'quote'
  | 'contract'
  | 'won'
  | 'delivering'
  | 'delivered'
  | 'invoiced'
  | 'lost';

const STAGE_ORDER: DealStage[] = [
  'inquiry',
  'qualified',
  'discovery',
  'quote',
  'contract',
  'won',
  'delivering',
  'delivered',
  'invoiced',
];

export interface DealAgreement {
  scope: string[];
  amount?: { value: number; currency: string };
  due_date?: string;
  success_condition?: string;
}

export interface DealRecord {
  kind: 'deal';
  deal_id: string;
  tenant_slug: string;
  channel: { surface: string; channel_id: string };
  stage: DealStage;
  lead_score?: { grade: string; score?: number };
  summary: string;
  requirements_ref?: string;
  quote_ref?: string;
  contract_ref?: string;
  agreed?: DealAgreement;
  mission_ids: string[];
  notes: Array<{ ts: string; role: 'customer' | 'kyberion' | 'operator'; text: string }>;
  created_at: string;
  updated_at: string;
}

function dealsDir(tenantSlug: string): string {
  return pathResolver.rootResolve(path.join('customer', tenantSlug, 'deals'));
}

function dealPath(tenantSlug: string, dealId: string): string {
  return path.join(dealsDir(tenantSlug), `${dealId}.json`);
}

function dealLogPath(tenantSlug: string): string {
  return path.join(dealsDir(tenantSlug), 'deal-log.jsonl');
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendDealLog(tenantSlug: string, event: Record<string, unknown>): void {
  try {
    safeMkdir(dealsDir(tenantSlug), { recursive: true });
    safeAppendFileSync(dealLogPath(tenantSlug), `${JSON.stringify({ ts: nowIso(), ...event })}\n`);
  } catch {
    // deal log is observability; never block the deal transition itself
  }
}

function writeDeal(deal: DealRecord): DealRecord {
  safeMkdir(dealsDir(deal.tenant_slug), { recursive: true });
  safeWriteFile(dealPath(deal.tenant_slug, deal.deal_id), JSON.stringify(deal, null, 2));
  return deal;
}

export function getDeal(tenantSlug: string, dealId: string): DealRecord | null {
  const filePath = dealPath(tenantSlug, dealId);
  try {
    if (!safeExistsSync(filePath)) return null;
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as DealRecord;
  } catch {
    return null;
  }
}

export function listDeals(tenantSlug: string): DealRecord[] {
  const dir = dealsDir(tenantSlug);
  if (!safeExistsSync(dir)) return [];
  let entries: string[] = [];
  try {
    entries = safeReaddir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith('DEAL-') && entry.endsWith('.json'))
    .map((entry) => getDeal(tenantSlug, entry.replace(/\.json$/, '')))
    .filter((deal): deal is DealRecord => Boolean(deal));
}

export function openDeal(input: {
  tenantSlug: string;
  surface: string;
  channelId: string;
  summary: string;
  leadScore?: { grade: string; score?: number };
}): DealRecord {
  const deal: DealRecord = {
    kind: 'deal',
    deal_id: `DEAL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    tenant_slug: input.tenantSlug,
    channel: { surface: input.surface, channel_id: input.channelId },
    stage: 'inquiry',
    ...(input.leadScore ? { lead_score: input.leadScore } : {}),
    summary: input.summary.slice(0, 500),
    mission_ids: [],
    notes: [],
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  writeDeal(deal);
  appendDealLog(input.tenantSlug, {
    event: 'deal_opened',
    deal_id: deal.deal_id,
    stage: 'inquiry',
  });
  return deal;
}

/**
 * The active deal for a bound channel: the most recently updated deal on the
 * same surface+channel that is not terminal. This is what makes "昨日の続き"
 * work across stateless conversations.
 */
export function getActiveDealForChannel(binding: ResolvedCustomerBinding): DealRecord | null {
  const terminal = new Set<DealStage>(['invoiced', 'lost']);
  const candidates = listDeals(binding.tenantSlug)
    .filter(
      (deal) =>
        deal.channel.surface === binding.binding.surface &&
        deal.channel.channel_id === binding.binding.channel_id &&
        !terminal.has(deal.stage)
    )
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return candidates[0] || null;
}

/**
 * Advance the deal stage. Forward-only along STAGE_ORDER (plus `lost` from
 * anywhere); moving backwards requires operator=true — agents must not
 * silently rewind a deal.
 */
export function advanceDealStage(input: {
  tenantSlug: string;
  dealId: string;
  stage: DealStage;
  evidence?: string;
  operator?: boolean;
  agreed?: DealAgreement;
  refs?: Partial<Pick<DealRecord, 'requirements_ref' | 'quote_ref' | 'contract_ref'>>;
  missionId?: string;
}): DealRecord {
  const deal = getDeal(input.tenantSlug, input.dealId);
  if (!deal) throw new Error(`deal_not_found:${input.dealId}`);
  if (input.stage !== 'lost' && !input.operator) {
    const from = STAGE_ORDER.indexOf(deal.stage);
    const to = STAGE_ORDER.indexOf(input.stage);
    if (to >= 0 && from >= 0 && to < from) {
      throw new Error(`deal_stage_rewind_requires_operator:${deal.stage}->${input.stage}`);
    }
  }
  const next: DealRecord = {
    ...deal,
    stage: input.stage,
    ...(input.agreed ? { agreed: input.agreed } : {}),
    ...(input.refs || {}),
    mission_ids: input.missionId
      ? Array.from(new Set([...deal.mission_ids, input.missionId]))
      : deal.mission_ids,
    updated_at: nowIso(),
  };
  writeDeal(next);
  appendDealLog(input.tenantSlug, {
    event: 'deal_stage_advanced',
    deal_id: deal.deal_id,
    from: deal.stage,
    to: input.stage,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  });
  // E2E-06 Task 7: agreement snapshots and the learning loop are transition
  // side effects of the state machine itself — failure-tolerant, never block.
  try {
    if (
      input.stage === 'won' ||
      input.stage === 'delivering' ||
      input.stage === 'delivered' ||
      input.stage === 'invoiced'
    ) {
      snapshotDealAgreement(next);
    }
  } catch {
    /* observability only */
  }
  try {
    if (input.stage === 'delivered' || input.stage === 'lost') {
      queueDealDistillCandidate(next);
    }
  } catch {
    /* the promotion queue may reject ineligible candidates — never block */
  }
  return next;
}

function snapshotDealAgreement(deal: DealRecord): void {
  if (!deal.agreed) return;
  const dir = path.join(dealsDir(deal.tenant_slug), deal.deal_id);
  safeMkdir(dir, { recursive: true });
  let version = 1;
  try {
    const versions = safeReaddir(dir)
      .map((entry) => entry.match(/^agreement-v(\d+)\.json$/))
      .filter(Boolean)
      .map((match) => Number(match![1]));
    version = versions.length > 0 ? Math.max(...versions) + 1 : 1;
  } catch {
    version = 1;
  }
  safeWriteFile(
    path.join(dir, `agreement-v${version}.json`),
    JSON.stringify(
      {
        kind: 'deal-agreement-snapshot',
        deal_id: deal.deal_id,
        stage: deal.stage,
        agreed: deal.agreed,
        quote_ref: deal.quote_ref,
        contract_ref: deal.contract_ref,
        mission_ids: deal.mission_ids,
        snapshotted_at: nowIso(),
      },
      null,
      2
    )
  );
}

function queueDealDistillCandidate(deal: DealRecord): void {
  const outcome = deal.stage === 'delivered' ? '受注・納品まで完了' : '失注';
  const recentNotes = deal.notes
    .slice(-8)
    .map((note) => `${note.role}: ${note.text.slice(0, 120)}`);
  const candidate = createMemoryPromotionCandidate({
    sourceType: 'artifact',
    sourceRef: `deal:${deal.tenant_slug}/${deal.deal_id}`,
    proposedMemoryKind: 'heuristic',
    summary: [
      `商談 ${deal.deal_id}(${outcome})の学び候補: ${deal.summary.slice(0, 160)}`,
      deal.agreed?.amount
        ? `合意金額 ${deal.agreed.amount.value} ${deal.agreed.amount.currency}`
        : '',
      recentNotes.length > 0 ? `直近のやりとり: ${recentNotes.join(' / ').slice(0, 400)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    evidenceRefs: [
      path.join('customer', deal.tenant_slug, 'deals', `${deal.deal_id}.json`),
      ...(deal.quote_ref ? [deal.quote_ref] : []),
      ...(deal.contract_ref ? [deal.contract_ref] : []),
    ],
    sensitivityTier: 'confidential',
    ratificationRequired: true,
  });
  enqueueMemoryPromotionCandidate(candidate);
  appendDealLog(deal.tenant_slug, {
    event: 'deal_distill_candidate_queued',
    deal_id: deal.deal_id,
    candidate_id: candidate.candidate_id,
  });
}

export function appendDealNote(input: {
  tenantSlug: string;
  dealId: string;
  role: 'customer' | 'kyberion' | 'operator';
  text: string;
}): DealRecord {
  const deal = getDeal(input.tenantSlug, input.dealId);
  if (!deal) throw new Error(`deal_not_found:${input.dealId}`);
  const next: DealRecord = {
    ...deal,
    notes: [
      ...deal.notes,
      { ts: nowIso(), role: input.role, text: input.text.slice(0, 2000) },
    ].slice(-50),
    updated_at: nowIso(),
  };
  return writeDeal(next);
}

export function summarizeDealForConversation(deal: DealRecord): string {
  const recent = deal.notes
    .slice(-6)
    .map((note) => `${note.role}: ${note.text}`)
    .join('\n');
  return [
    `Deal ${deal.deal_id} (stage: ${deal.stage})`,
    `Summary: ${deal.summary}`,
    deal.agreed?.scope?.length ? `Agreed scope: ${deal.agreed.scope.join(' / ')}` : '',
    deal.agreed?.amount
      ? `Agreed amount: ${deal.agreed.amount.value} ${deal.agreed.amount.currency}`
      : '',
    recent ? `Recent notes:\n${recent}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// E2E-06 Task 5 (deterministic part): quote math from the price book.
// LLMs never do this arithmetic — rules only. Unknown task kinds are
// unquotable and must go to the operator.
// ---------------------------------------------------------------------------

export interface PriceBook {
  version: string;
  currency: string;
  items: Array<{ sku: string; name: string; unit: string; unit_price: number; notes?: string }>;
  estimate_rules?: Array<{
    task_kind: string;
    base_hours: number;
    rate_sku: string;
    size_multipliers?: Record<string, number>;
  }>;
}

export interface QuoteLineRequest {
  task_kind: string;
  size?: string;
  description?: string;
}

export interface QuoteResult {
  ok: boolean;
  currency: string;
  lines: Array<{
    description: string;
    task_kind: string;
    hours: number;
    rate_sku: string;
    unit_price: number;
    amount: number;
  }>;
  total: number;
  unquotable: Array<{ task_kind: string; reason: string }>;
}

export function loadPriceBook(tenantSlug?: string): PriceBook | null {
  const candidates = [
    ...(tenantSlug
      ? [pathResolver.knowledge(path.join('confidential', tenantSlug, 'sales', 'price-book.json'))]
      : []),
    pathResolver.knowledge('product/sales/price-book.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (!safeExistsSync(candidate)) continue;
      return JSON.parse(safeReadFile(candidate, { encoding: 'utf8' }) as string) as PriceBook;
    } catch {
      continue;
    }
  }
  return null;
}

export function buildQuoteFromPriceBook(
  requests: QuoteLineRequest[],
  priceBook: PriceBook
): QuoteResult {
  const lines: QuoteResult['lines'] = [];
  const unquotable: QuoteResult['unquotable'] = [];
  for (const request of requests) {
    const rule = (priceBook.estimate_rules || []).find(
      (entry) => entry.task_kind === request.task_kind
    );
    if (!rule) {
      unquotable.push({ task_kind: request.task_kind, reason: 'no_estimate_rule' });
      continue;
    }
    const item = priceBook.items.find((entry) => entry.sku === rule.rate_sku);
    if (!item) {
      unquotable.push({ task_kind: request.task_kind, reason: `missing_sku:${rule.rate_sku}` });
      continue;
    }
    const multiplier =
      request.size && rule.size_multipliers?.[request.size] !== undefined
        ? rule.size_multipliers[request.size]
        : 1;
    const hours = rule.base_hours * multiplier;
    lines.push({
      description: request.description || request.task_kind,
      task_kind: request.task_kind,
      hours,
      rate_sku: rule.rate_sku,
      unit_price: item.unit_price,
      amount: Math.round(hours * item.unit_price),
    });
  }
  return {
    ok: unquotable.length === 0 && lines.length > 0,
    currency: priceBook.currency,
    lines,
    total: lines.reduce((sum, line) => sum + line.amount, 0),
    unquotable,
  };
}
