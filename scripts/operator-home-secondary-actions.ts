import {
  ingestAudioIntoDealRequirements,
  readDealRequirementsCapture,
} from '@agent/core/customer-conversation-modes';
import { listCustomerChannelBindings } from '@agent/core/customer-channel-binding';
import { listDeals, type QuoteLineRequest } from '@agent/core/deal-store';
import {
  draftContractForDeal,
  generateQuoteForDeal,
  handoffWonDealToSdlc,
  recordContractReview,
} from '@agent/core/deal-documents';
import {
  listDistillCandidateRecords,
  updateDistillCandidateRecord,
} from '@agent/core/knowledge/distill-candidate-registry';
import {
  materializeExecutionFeedbackCandidate,
  recordExecutionFeedback,
} from '@agent/core/execution-feedback';
import type { VocabularyKey } from '@agent/core/t';
import { withExecutionContext } from '@agent/core/authority';
import { ScriptExitError } from './lib/harness.js';

/**
 * Governed role for the operator's deal-document writes. They land under
 * customer/{tenant}/deals/ (and, for the handoff, the mission's intent and
 * requirements drafts); security-policy.json grants customer/ writes to
 * mission_controller, the same role the deal-documents module tests use.
 */
const DEAL_DOCUMENT_WRITE_ROLE = 'mission_controller';

export type HomeUi = (key: VocabularyKey, params?: Record<string, string | number>) => string;
export type HomePrint = (value: unknown) => void;

export function handleFeedbackSubcommand(
  ui: HomeUi,
  argv: {
    intentId?: string;
    scenarioId?: string;
    outcome?: string;
    comment?: string;
    correction?: string;
    procedureId?: string;
    correlationId?: string;
    json?: boolean;
  },
  print: HomePrint = () => undefined
): void {
  const intentId = String(argv.intentId || '').trim();
  const outcome = String(argv.outcome || '').trim() as
    'satisfied' | 'partially_satisfied' | 'dissatisfied';
  if (!intentId || !['satisfied', 'partially_satisfied', 'dissatisfied'].includes(outcome)) {
    print(ui('recorder:recorder_feedback_usage'));
    throw new ScriptExitError(1, '', true);
  }
  const feedback = recordExecutionFeedback({
    scenario_id: argv.scenarioId || `use-case-${intentId}`,
    intent_id: intentId,
    outcome,
    comment: argv.comment,
    correction: argv.correction,
    correlation_id: argv.correlationId,
    source: 'operator',
    surface: 'cli',
  });
  const improvement = materializeExecutionFeedbackCandidate({
    feedback,
    procedureId: argv.procedureId || intentId,
  });
  const payload = { feedback, summary: improvement.summary, candidate: improvement.candidate };
  if (argv.json) {
    print(JSON.stringify(payload, null, 2));
    return;
  }
  print(
    ui('recorder:recorder_feedback_recorded', {
      id: feedback.feedback_id,
      outcome: feedback.outcome,
    })
  );
  if (improvement.candidate) {
    print(ui('recorder:recorder_feedback_candidate', { id: improvement.candidate.candidate_id }));
    print(ui('recorder:recorder_feedback_review', { id: improvement.candidate.candidate_id }));
  } else {
    print(ui('recorder:recorder_no_improvement'));
  }
}

export function handleImprovements(
  ui: HomeUi,
  argv: {
    approve?: string;
    deny?: string;
    note?: string;
    json?: boolean;
  },
  print: HomePrint = () => undefined
): void {
  if (argv.approve || argv.deny) {
    const candidateId = String(argv.approve || argv.deny);
    const candidate = listDistillCandidateRecords().find(
      (entry) => entry.candidate_id === candidateId
    );
    if (!candidate || candidate.status !== 'proposed') {
      print(ui('recorder:recorder_improvement_not_found', { id: candidateId }));
      throw new ScriptExitError(1, '', true);
    }
    const reviewed = updateDistillCandidateRecord(candidateId, {
      status: argv.approve ? 'promoted' : 'archived',
      ...(argv.approve ? { promoted_ref: `procedure-improvement:${candidateId}` } : {}),
      metadata: {
        ...(candidate.metadata || {}),
        review: {
          status: argv.approve ? 'approved' : 'rejected',
          reviewer: 'human:operator',
          note: argv.note || 'reviewed via pnpm kyberion improvements',
        },
      },
    });
    print(
      ui('recorder:recorder_improvement_updated', {
        id: reviewed?.candidate_id || candidateId,
        status: reviewed?.status || 'unknown',
      })
    );
    if (argv.approve) print(ui('recorder:recorder_catalog_review_note'));
    return;
  }
  const candidates = listDistillCandidateRecords().filter(
    (candidate) => candidate.metadata?.improvement_kind === 'execution_feedback'
  );
  if (argv.json) {
    print(JSON.stringify(candidates, null, 2));
    return;
  }
  if (candidates.length === 0) {
    print(ui('recorder:recorder_no_candidates'));
    return;
  }
  print(ui('recorder:recorder_improvement_header', { count: candidates.length }));
  for (const candidate of candidates) {
    print(`  [${candidate.candidate_id}] ${candidate.status} ${candidate.title}`);
    print(`      ${candidate.summary}`);
  }
  print(ui('recorder:recorder_improvement_approve'));
}

// Customer-path operator view: which deals are live, at what stage, and what
// the requirements hearing has captured so far (E2E-06 follow-up).
export async function handleDealsIngestAudio(
  ui: HomeUi,
  argv: {
    ingestAudio?: string;
    audio?: string;
  },
  print: HomePrint = () => undefined
): Promise<void> {
  const bindings = listCustomerChannelBindings();
  const tenants = Array.from(new Set(bindings.map((binding) => binding.tenantSlug)));
  const match = tenants
    .flatMap((tenantSlug) => listDeals(tenantSlug).map((deal) => ({ tenantSlug, deal })))
    .find((entry) => entry.deal.deal_id === argv.ingestAudio);
  if (!match) {
    print(ui('recorder:recorder_deal_not_found', { id: argv.ingestAudio || '' }));
    throw new ScriptExitError(1, '', true);
  }
  if (!argv.audio) {
    print(ui('recorder:recorder_deal_audio_usage'));
    throw new ScriptExitError(1, '', true);
  }
  const result = await ingestAudioIntoDealRequirements({
    tenantSlug: match.tenantSlug,
    dealId: match.deal.deal_id,
    audioPath: argv.audio,
    projectName: match.deal.summary?.slice(0, 80),
  });
  if (!result) {
    print(ui('recorder:recorder_deal_audio_failed'));
    throw new ScriptExitError(1, '', true);
  }
  print(ui('recorder:recorder_deal_audio_updated', { count: result.capture.turns_captured }));
  if (result.transcript_path)
    print(ui('recorder:recorder_deal_transcript', { path: result.transcript_path }));
  print(ui('recorder:recorder_deal_requirements_next', { id: match.deal.deal_id }));
}

export function handleDealsSubcommand(
  ui: HomeUi,
  argv: { requirements?: string; json?: boolean },
  print: HomePrint = () => undefined
): void {
  const bindings = listCustomerChannelBindings();
  const tenants = Array.from(new Set(bindings.map((binding) => binding.tenantSlug)));
  const deals = tenants.flatMap((tenantSlug) =>
    listDeals(tenantSlug).map((deal) => ({ tenantSlug, deal }))
  );

  if (argv.requirements) {
    const match = deals.find((entry) => entry.deal.deal_id === argv.requirements);
    if (!match) {
      print(ui('recorder:recorder_deal_not_found', { id: argv.requirements }));
      throw new ScriptExitError(1, '', true);
    }
    const capture = readDealRequirementsCapture(match.tenantSlug, match.deal.deal_id);
    if (!capture) {
      print(
        ui('recorder:recorder_deal_requirements_none', {
          id: match.deal.deal_id,
          stage: match.deal.stage,
        })
      );
      return;
    }
    if (argv.json) {
      print(JSON.stringify(capture, null, 2));
      return;
    }
    const req = capture.requirements;
    print(
      ui('recorder:recorder_deal_requirements_header', {
        id: match.deal.deal_id,
        turns: capture.turns_captured,
        updated: capture.updated_at,
      })
    );
    for (const fr of req.functional_requirements || []) {
      print(`  [${fr.priority}] ${fr.id}: ${fr.description}`);
    }
    for (const nfr of req.non_functional_requirements || []) {
      print(`  [nfr:${nfr.category}] ${nfr.description}`);
    }
    const open = (req.open_questions || []).filter((q) => (q.status || 'open') === 'open');
    if (open.length > 0) {
      print(ui('recorder:recorder_deal_open_questions'));
      for (const q of open) print(`    - ${q.blocking ? '[blocking] ' : ''}${q.question}`);
    }
    return;
  }

  if (argv.json) {
    print(JSON.stringify(deals, null, 2));
    return;
  }
  if (deals.length === 0) {
    print(ui('recorder:recorder_deal_empty'));
    return;
  }
  print(ui('recorder:recorder_deal_header', { count: deals.length }));
  for (const { tenantSlug, deal } of deals) {
    print(
      `  [${deal.deal_id}] ${tenantSlug} / ${deal.stage.padEnd(10)} ${deal.summary.slice(0, 60)}`
    );
  }
  print('');
  print(ui('recorder:recorder_deal_requirements_command'));
}

export interface DealDocumentArgs {
  quote?: string;
  lines?: string;
  draftContract?: string;
  reviewContract?: string;
  contractVersion?: number;
  verdict?: string;
  reviewer?: string;
  note?: string;
  handoff?: string;
  missionId?: string;
  /** Tenant owning the deal; required when the deal id exists in several tenants. */
  tenant?: string;
  json?: boolean;
}

/** yargs options for the deal-document actions of `pnpm kyberion deals`. */
export const DEAL_DOCUMENT_OPTIONS = {
  quote: { type: 'string', description: 'deals: price-book quote for a deal id' },
  lines: { type: 'string', description: 'deals: JSON array of quote line requests' },
  'draft-contract': { type: 'string', description: 'deals: draft the contract for a deal id' },
  'review-contract': { type: 'string', description: 'deals: record a contract review verdict' },
  'contract-version': { type: 'number', description: 'deals: contract version reviewed' },
  verdict: { type: 'string', choices: ['approve', 'reject'] },
  handoff: { type: 'string', description: 'deals: hand a won deal to --mission-id' },
  tenant: {
    type: 'string',
    description: 'deals: tenant owning the deal (required when the id is ambiguous)',
  },
} as const;

/** Map the operator-home yargs result onto the deal-document arguments. */
export function dealDocumentArgsFromArgv(argv: Record<string, unknown>): DealDocumentArgs {
  const text = (key: string) => (argv[key] ? String(argv[key]) : undefined);
  return {
    quote: text('quote'),
    lines: text('lines'),
    draftContract: text('draft-contract'),
    reviewContract: text('review-contract'),
    contractVersion:
      typeof argv['contract-version'] === 'number' ? Number(argv['contract-version']) : undefined,
    verdict: text('verdict'),
    reviewer: text('reviewer'),
    note: text('note'),
    handoff: text('handoff'),
    missionId: text('mission-id'),
    tenant: text('tenant'),
    json: Boolean(argv.json),
  };
}

/** True when argv asks for one of the E2E-06 deal-document actions. */
export function isDealDocumentAction(argv: DealDocumentArgs): boolean {
  return Boolean(argv.quote || argv.draftContract || argv.reviewContract || argv.handoff);
}

function parseQuoteLines(raw: string | undefined): QuoteLineRequest[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const lines = parsed.filter(
      (entry): entry is QuoteLineRequest =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { task_kind?: unknown }).task_kind === 'string'
    );
    return lines.length === parsed.length ? lines : null;
  } catch {
    return null;
  }
}

/**
 * E2E-06 Tasks 5/6 from the operator console: quote, contract draft, contract
 * review record and the won → SDLC handoff (libs/core/deal-documents.ts).
 * Sending a document to the customer is not offered here — it needs the
 * customer channel binding and stays on the approval-gated
 * sendDealDocumentToCustomer path of the conversation runtime.
 */
export function handleDealDocumentAction(
  ui: HomeUi,
  argv: DealDocumentArgs,
  print: HomePrint = () => undefined
): boolean {
  if (!isDealDocumentAction(argv)) return false;
  const dealId = String(argv.quote || argv.draftContract || argv.reviewContract || argv.handoff);
  const tenants = argv.tenant
    ? [argv.tenant]
    : Array.from(new Set(listCustomerChannelBindings().map((binding) => binding.tenantSlug)));
  const owners = tenants.filter((tenant) =>
    listDeals(tenant).some((deal) => deal.deal_id === dealId)
  );
  if (owners.length === 0) {
    print(ui('recorder:recorder_deal_not_found', { id: dealId }));
    throw new ScriptExitError(1, '', true);
  }
  if (owners.length > 1) {
    print(
      ui('recorder:recorder_deal_tenant_ambiguous', { id: dealId, tenants: owners.join(', ') })
    );
    throw new ScriptExitError(1, '', true);
  }
  const tenantSlug = owners[0];
  const governed = <T>(write: () => T): T =>
    withExecutionContext(DEAL_DOCUMENT_WRITE_ROLE, write, undefined, tenantSlug);
  const emit = (value: Record<string, unknown>, line: string) =>
    print(argv.json ? JSON.stringify(value, null, 2) : line);

  if (argv.quote) {
    const requests = parseQuoteLines(argv.lines);
    if (!requests) {
      print(ui('recorder:recorder_deal_quote_usage'));
      throw new ScriptExitError(1, '', true);
    }
    const result = governed(() => generateQuoteForDeal({ tenantSlug, dealId, requests }));
    if (!result.ok) {
      emit(
        { ok: false, unquotable: result.unquotable ?? [] },
        ui('recorder:recorder_deal_quote_unquotable', {
          kinds: (result.unquotable ?? []).map((entry) => entry.task_kind).join(', '),
        })
      );
      throw new ScriptExitError(1, '', true);
    }
    emit(
      { ok: true, version: result.version, quote_ref: result.quote_ref, quote: result.quote },
      ui('recorder:recorder_deal_quote_created', {
        id: dealId,
        version: result.version ?? 0,
        path: result.quote_ref ?? '',
      })
    );
    return true;
  }

  if (argv.draftContract) {
    const result = governed(() => draftContractForDeal({ tenantSlug, dealId }));
    emit(
      { version: result.version, contract_ref: result.contract_ref },
      ui('recorder:recorder_deal_contract_created', {
        id: dealId,
        version: result.version,
        path: result.contract_ref,
      })
    );
    return true;
  }

  if (argv.reviewContract) {
    const version = Number(argv.contractVersion);
    const verdict = String(argv.verdict || '');
    if (
      !Number.isInteger(version) ||
      version < 1 ||
      (verdict !== 'approve' && verdict !== 'reject') ||
      !argv.reviewer
    ) {
      print(ui('recorder:recorder_deal_review_usage'));
      throw new ScriptExitError(1, '', true);
    }
    const recordPath = governed(() =>
      recordContractReview({
        tenantSlug,
        dealId,
        version,
        verdict,
        reviewer: String(argv.reviewer),
        ...(argv.note ? { notes: String(argv.note) } : {}),
      })
    );
    emit(
      { record_path: recordPath, verdict, version },
      ui('recorder:recorder_deal_review_recorded', { id: dealId, version, verdict })
    );
    return true;
  }

  if (!argv.missionId) {
    print(ui('recorder:recorder_deal_handoff_usage'));
    throw new ScriptExitError(1, '', true);
  }
  const result = governed(() =>
    handoffWonDealToSdlc({ tenantSlug, dealId, missionId: String(argv.missionId) })
  );
  emit(
    {
      handoff_path: result.handoff_path,
      sdlc_pipeline: result.sdlc_pipeline,
      ...(result.requirements_draft_version
        ? { requirements_draft_version: result.requirements_draft_version }
        : {}),
    },
    ui('recorder:recorder_deal_handoff_done', {
      id: dealId,
      mission: String(argv.missionId),
      pipeline: result.sdlc_pipeline,
    })
  );
  return true;
}
