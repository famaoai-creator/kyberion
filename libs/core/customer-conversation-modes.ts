import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { logger } from './core.js';
import type { ResolvedCustomerBinding } from './customer-channel-binding.js';
import type { DealRecord, DealStage } from './deal-store.js';
import type { ExtractedRequirements } from './reasoning-backend.js';

/**
 * Customer conversation modes — the direct-to-customer paths (sales,
 * customer support, upstream requirements elicitation) share one grounded
 * handler (`runCustomerConversation`) but need different conversational
 * *jobs*. The mode decides what the avatar is trying to accomplish in each
 * turn; the disclosure policy is shared and absolute regardless of mode.
 *
 * Mode resolution: explicit binding override > deal stage mapping.
 *  - inquiry/qualified/quote/contract → sales (advance the deal)
 *  - discovery                        → requirements_hearing (elicit + record)
 *  - won/delivering/delivered/invoiced → support (keep the customer unblocked)
 */

export type CustomerConversationMode = 'sales' | 'support' | 'requirements_hearing';

const STAGE_TO_MODE: Readonly<Record<DealStage, CustomerConversationMode>> = {
  inquiry: 'sales',
  qualified: 'sales',
  discovery: 'requirements_hearing',
  quote: 'sales',
  contract: 'sales',
  won: 'support',
  delivering: 'support',
  delivered: 'support',
  invoiced: 'support',
  lost: 'sales',
};

export function resolveConversationMode(
  binding: ResolvedCustomerBinding,
  deal: Pick<DealRecord, 'stage'>
): CustomerConversationMode {
  const override = (binding.binding as { mode?: string }).mode;
  if (override === 'sales' || override === 'support' || override === 'requirements_hearing') {
    return override;
  }
  return STAGE_TO_MODE[deal.stage] || 'sales';
}

/**
 * Conversation principles — the customer-facing analog of
 * working-principles.ts: mechanical rules that keep any model tier
 * professional and convergent. Shared across all modes.
 */
export const CUSTOMER_CONVERSATION_PRINCIPLES: readonly string[] = [
  'Restate the customer ask in one sentence before answering, so misunderstandings surface immediately.',
  'Every reply ends with exactly one concrete next step (a question to answer, a date to confirm, or an action you will take).',
  'Ask at most ONE question per reply — the single most blocking one.',
  'Never leave a customer question unaddressed: answer it from the grounding, or say you will confirm and escalate it.',
  'Match the customer language and formality; keep replies under 10 sentences.',
] as const;

const MODE_PROMPT_LINES: Readonly<Record<CustomerConversationMode, readonly string[]>> = {
  sales: [
    'MODE: sales — your job this turn is to advance the deal one stage.',
    '- Qualify in this order: need → decision process → timeline → budget. Fill the earliest gap first.',
    '- Propose only solutions present in the SOLUTION CATALOG; map the customer need to a catalog item by name.',
    '- Quote prices only when they are literally in the PRICE BOOK; otherwise escalate for a quote.',
    '- If the customer signals readiness (asks about price, contract, start date), state the concrete next step toward quote/contract.',
  ],
  requirements_hearing: [
    'MODE: requirements hearing — your job this turn is to make the requirements picture more complete.',
    '- Coverage checklist, in priority order: goal/success criteria → users & scenarios → functional needs → non-functional needs (performance, security, availability) → constraints (budget, timeline, tech) → out-of-scope.',
    '- Look at OPEN QUESTIONS in the deal context; ask the single most blocking one. If none are recorded, ask about the earliest uncovered checklist area.',
    '- After the customer answers, confirm your understanding by restating what you captured in one or two bullet points.',
    '- Never design solutions in this mode; capture what and why, not how.',
  ],
  support: [
    'MODE: customer support — your job this turn is to unblock the customer.',
    '- First identify: which deliverable/feature, what did they expect, what happened instead, since when.',
    '- Ask for reproduction steps when the report is about broken behavior and steps are missing.',
    '- If the KNOWN ISSUES notes cover it, give the documented workaround verbatim.',
    '- Outages, data loss, or security concerns: apologize once, say the team is on it, and escalate immediately — do not troubleshoot inline.',
  ],
};

export function buildModePromptLines(mode: CustomerConversationMode): string[] {
  return [
    ...MODE_PROMPT_LINES[mode],
    '',
    'CONVERSATION PRINCIPLES (all modes):',
    ...CUSTOMER_CONVERSATION_PRINCIPLES.map((rule) => `- ${rule}`),
  ];
}

/**
 * Support grounding: tenant known-issues notes, so support-mode replies can
 * cite documented workarounds instead of improvising.
 */
export function loadSupportGrounding(tenantSlug: string): { knownIssues: string; found: boolean } {
  const candidates = [
    pathResolver.knowledge(path.join('confidential', tenantSlug, 'support', 'known-issues.md')),
    pathResolver.knowledge('product/sales/known-issues.md'),
  ];
  for (const candidate of candidates) {
    try {
      if (safeExistsSync(candidate)) {
        return {
          knownIssues: String(safeReadFile(candidate, { encoding: 'utf8' })).slice(0, 4000),
          found: true,
        };
      }
    } catch {
      // unreadable grounding is the same as missing grounding
    }
  }
  return { knownIssues: '', found: false };
}

// ----- Requirements capture (requirements_hearing mode) -----

export interface DealRequirementsCapture {
  deal_id: string;
  tenant_slug: string;
  updated_at: string;
  turns_captured: number;
  requirements: ExtractedRequirements;
}

function dealRequirementsPath(tenantSlug: string, dealId: string): string {
  // Lives in the deal's document directory (customer/<tenant>/deals/<id>/,
  // same convention as deal-documents) — NOT as a sibling of DEAL-*.json,
  // which listDeals() would misread as a deal record.
  return pathResolver.rootResolve(
    path.join('customer', tenantSlug, 'deals', dealId, 'requirements.json')
  );
}

export function readDealRequirementsCapture(
  tenantSlug: string,
  dealId: string
): DealRequirementsCapture | null {
  const filePath = dealRequirementsPath(tenantSlug, dealId);
  try {
    if (!safeExistsSync(filePath)) return null;
    return JSON.parse(
      safeReadFile(filePath, { encoding: 'utf8' }) as string
    ) as DealRequirementsCapture;
  } catch (err) {
    logger.warn(
      `[customer-conversation-modes] unreadable requirements capture ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

export function saveDealRequirementsCapture(input: {
  tenantSlug: string;
  dealId: string;
  requirements: ExtractedRequirements;
}): DealRequirementsCapture {
  const previous = readDealRequirementsCapture(input.tenantSlug, input.dealId);
  const capture: DealRequirementsCapture = {
    deal_id: input.dealId,
    tenant_slug: input.tenantSlug,
    updated_at: new Date().toISOString(),
    turns_captured: (previous?.turns_captured || 0) + 1,
    requirements: input.requirements,
  };
  const filePath = dealRequirementsPath(input.tenantSlug, input.dealId);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(capture, null, 2));
  return capture;
}

/** Compact open-question list for the hearing prompt (top blockers first). */
export function summarizeOpenQuestionsForPrompt(
  capture: DealRequirementsCapture | null,
  limit = 5
): string {
  const questions = (capture?.requirements.open_questions || [])
    .filter((question) => (question.status || 'open') === 'open')
    .sort((a, b) => Number(Boolean(b.blocking)) - Number(Boolean(a.blocking)))
    .slice(0, limit)
    .map((question) => `- ${question.blocking ? '[blocking] ' : ''}${question.question}`);
  return questions.length > 0 ? questions.join('\n') : '- (none recorded yet)';
}
