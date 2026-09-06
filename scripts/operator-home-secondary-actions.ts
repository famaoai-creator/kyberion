import {
  ingestAudioIntoDealRequirements,
  readDealRequirementsCapture,
} from '@agent/core/customer-conversation-modes';
import { listCustomerChannelBindings } from '@agent/core/customer-channel-binding';
import { listDeals } from '@agent/core/deal-store';
import {
  listDistillCandidateRecords,
  updateDistillCandidateRecord,
} from '@agent/core/distill-candidate-registry';
import {
  materializeExecutionFeedbackCandidate,
  recordExecutionFeedback,
} from '@agent/core/execution-feedback';
import type { VocabularyKey } from '@agent/core/t';
import { ScriptExitError } from './lib/harness.js';

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
