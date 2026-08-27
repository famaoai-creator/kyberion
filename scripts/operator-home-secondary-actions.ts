import {
  ingestAudioIntoDealRequirements,
  listCustomerChannelBindings,
  listDeals,
  listDistillCandidateRecords,
  materializeExecutionFeedbackCandidate,
  readDealRequirementsCapture,
  recordExecutionFeedback,
  updateDistillCandidateRecord,
} from '@agent/core';
import type { VocabularyKey } from '@agent/core';

export type HomeUi = (key: VocabularyKey, params?: Record<string, string | number>) => string;

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
  }
): void {
  const intentId = String(argv.intentId || '').trim();
  const outcome = String(argv.outcome || '').trim() as
    'satisfied' | 'partially_satisfied' | 'dissatisfied';
  if (!intentId || !['satisfied', 'partially_satisfied', 'dissatisfied'].includes(outcome)) {
    console.error(ui('recorder:recorder_feedback_usage'));
    process.exitCode = 1;
    return;
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
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(
    ui('recorder:recorder_feedback_recorded', {
      id: feedback.feedback_id,
      outcome: feedback.outcome,
    })
  );
  if (improvement.candidate) {
    console.log(
      ui('recorder:recorder_feedback_candidate', { id: improvement.candidate.candidate_id })
    );
    console.log(
      ui('recorder:recorder_feedback_review', { id: improvement.candidate.candidate_id })
    );
  } else {
    console.log(ui('recorder:recorder_no_improvement'));
  }
}

export function handleImprovements(
  ui: HomeUi,
  argv: {
    approve?: string;
    deny?: string;
    note?: string;
    json?: boolean;
  }
): void {
  if (argv.approve || argv.deny) {
    const candidateId = String(argv.approve || argv.deny);
    const candidate = listDistillCandidateRecords().find(
      (entry) => entry.candidate_id === candidateId
    );
    if (!candidate || candidate.status !== 'proposed') {
      console.error(ui('recorder:recorder_improvement_not_found', { id: candidateId }));
      process.exitCode = 1;
      return;
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
    console.log(
      ui('recorder:recorder_improvement_updated', {
        id: reviewed?.candidate_id || candidateId,
        status: reviewed?.status || 'unknown',
      })
    );
    if (argv.approve) console.log(ui('recorder:recorder_catalog_review_note'));
    return;
  }
  const candidates = listDistillCandidateRecords().filter(
    (candidate) => candidate.metadata?.improvement_kind === 'execution_feedback'
  );
  if (argv.json) {
    console.log(JSON.stringify(candidates, null, 2));
    return;
  }
  if (candidates.length === 0) {
    console.log(ui('recorder:recorder_no_candidates'));
    return;
  }
  console.log(ui('recorder:recorder_improvement_header', { count: candidates.length }));
  for (const candidate of candidates) {
    console.log(`  [${candidate.candidate_id}] ${candidate.status} ${candidate.title}`);
    console.log(`      ${candidate.summary}`);
  }
  console.log(ui('recorder:recorder_improvement_approve'));
}

// Customer-path operator view: which deals are live, at what stage, and what
// the requirements hearing has captured so far (E2E-06 follow-up).
export async function handleDealsIngestAudio(
  ui: HomeUi,
  argv: {
    ingestAudio?: string;
    audio?: string;
  }
): Promise<void> {
  const bindings = listCustomerChannelBindings();
  const tenants = Array.from(new Set(bindings.map((binding) => binding.tenantSlug)));
  const match = tenants
    .flatMap((tenantSlug) => listDeals(tenantSlug).map((deal) => ({ tenantSlug, deal })))
    .find((entry) => entry.deal.deal_id === argv.ingestAudio);
  if (!match) {
    console.error(ui('recorder:recorder_deal_not_found', { id: argv.ingestAudio || '' }));
    process.exitCode = 1;
    return;
  }
  if (!argv.audio) {
    console.error(ui('recorder:recorder_deal_audio_usage'));
    process.exitCode = 1;
    return;
  }
  const result = await ingestAudioIntoDealRequirements({
    tenantSlug: match.tenantSlug,
    dealId: match.deal.deal_id,
    audioPath: argv.audio,
    projectName: match.deal.summary?.slice(0, 80),
  });
  if (!result) {
    console.error(ui('recorder:recorder_deal_audio_failed'));
    process.exitCode = 1;
    return;
  }
  console.log(ui('recorder:recorder_deal_audio_updated', { count: result.capture.turns_captured }));
  if (result.transcript_path)
    console.log(ui('recorder:recorder_deal_transcript', { path: result.transcript_path }));
  console.log(ui('recorder:recorder_deal_requirements_next', { id: match.deal.deal_id }));
}

export function handleDealsSubcommand(
  ui: HomeUi,
  argv: { requirements?: string; json?: boolean }
): void {
  const bindings = listCustomerChannelBindings();
  const tenants = Array.from(new Set(bindings.map((binding) => binding.tenantSlug)));
  const deals = tenants.flatMap((tenantSlug) =>
    listDeals(tenantSlug).map((deal) => ({ tenantSlug, deal }))
  );

  if (argv.requirements) {
    const match = deals.find((entry) => entry.deal.deal_id === argv.requirements);
    if (!match) {
      console.error(ui('recorder:recorder_deal_not_found', { id: argv.requirements }));
      process.exitCode = 1;
      return;
    }
    const capture = readDealRequirementsCapture(match.tenantSlug, match.deal.deal_id);
    if (!capture) {
      console.log(
        ui('recorder:recorder_deal_requirements_none', {
          id: match.deal.deal_id,
          stage: match.deal.stage,
        })
      );
      return;
    }
    if (argv.json) {
      console.log(JSON.stringify(capture, null, 2));
      return;
    }
    const req = capture.requirements;
    console.log(
      ui('recorder:recorder_deal_requirements_header', {
        id: match.deal.deal_id,
        turns: capture.turns_captured,
        updated: capture.updated_at,
      })
    );
    for (const fr of req.functional_requirements || []) {
      console.log(`  [${fr.priority}] ${fr.id}: ${fr.description}`);
    }
    for (const nfr of req.non_functional_requirements || []) {
      console.log(`  [nfr:${nfr.category}] ${nfr.description}`);
    }
    const open = (req.open_questions || []).filter((q) => (q.status || 'open') === 'open');
    if (open.length > 0) {
      console.log(ui('recorder:recorder_deal_open_questions'));
      for (const q of open) console.log(`    - ${q.blocking ? '[blocking] ' : ''}${q.question}`);
    }
    return;
  }

  if (argv.json) {
    console.log(JSON.stringify(deals, null, 2));
    return;
  }
  if (deals.length === 0) {
    console.log(ui('recorder:recorder_deal_empty'));
    return;
  }
  console.log(ui('recorder:recorder_deal_header', { count: deals.length }));
  for (const { tenantSlug, deal } of deals) {
    console.log(
      `  [${deal.deal_id}] ${tenantSlug} / ${deal.stage.padEnd(10)} ${deal.summary.slice(0, 60)}`
    );
  }
  console.log('');
  console.log(ui('recorder:recorder_deal_requirements_command'));
}
