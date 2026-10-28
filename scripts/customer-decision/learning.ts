/**
 * CD-12: `customer-decision learning` — count what a tenant's customer
 * decisions teach us, write the tenant learning report and queue the
 * improvement suggestions as organization learning candidates; and
 * `learning --install`, the weekly tenant pipeline.
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 *
 *   1. read every case of the tenant (agendas, receipts, switches) as the
 *      tenant-bound `decision_ledger` role — no case lock, nothing else read;
 *   2. metrics and suggestions (`libs/core/customer-decision/learning.ts`,
 *      pure, minimum sample sizes);
 *   3. unless `--dry-run`: the report
 *      `knowledge/confidential/<tenant>/decisions/_reports/learning-<date>.json`
 *      (schema-validated, the ledger role's own write scope), then one
 *      candidate per suggestion through `enqueueOperationalLearningCandidateOnce`
 *      (source `customer_decision`, tier confidential, the tenant; the
 *      existing narrow `operational_learning_writer` role, bound to this
 *      tenant). One standing candidate per tenant × suggestion key: a
 *      suggestion an earlier report already stands for (any date, any
 *      organization; the candidate in any status) is not queued again unless
 *      its evidence materially changed (`isMaterialEvidenceChange`). The
 *      earlier reports are the tenant-level record, because the writer role
 *      reads only one organization's store; the whole step runs under a
 *      tenant lock. The org default compared is the one in force (product
 *      template, else the latest agenda). The operator accepts one with
 *      `organization learning transition`; no product template is changed here.
 *
 * Output: ids and counts (the weekly op passes them on; the pipeline context
 * is not tenant-partitioned). No role is widened.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { withLockSync } from '@agent/core/foundation/lock-utils';
import { pathResolver } from '@agent/core/path-resolver';
import { t } from '@agent/core/t';
import { enqueueOperationalLearningCandidateOnce } from '@agent/core/operational-learning';
import {
  DEFAULT_LEARNING_THRESHOLDS,
  CUSTOMER_DECISION_LEARNING_REPORT_VERSION,
  buildDecisionLearningMetrics,
  buildLearningSuggestions,
  isMaterialEvidenceChange,
  loadDecisionTemplate,
  learningCandidateId,
  learningReportPath,
  listAgendas,
  listLearningReportDates,
  listReceipts,
  readLearningReport,
  readSwitches,
  standingLearningSuggestions,
  utcDate,
  writeLearningReport,
  type CustomerDecisionLearningReport,
  type LearningCaseInput,
  type LearningSuggestion,
} from '@agent/core/customer-decision';
import { installRepositoryPipelineTemplate } from '../pipeline_promote.js';
import {
  LEDGER_ROLE,
  asLedgerWriter,
  audit,
  diagnosticCode,
  memberActorId,
  usageError,
} from './common.js';
import { boundTenantOf, nowOf, selectedCaseIds } from './overview.js';

export const LEARNING_PIPELINE_TEMPLATE =
  'knowledge/product/pipeline-templates/customer-decision-learning.json';
export const LEARNING_PIPELINE_NAME = 'customer-decision-learning';

export interface LearningRunResult {
  tenant: string;
  dry_run: boolean;
  report_date: string;
  /** Repo-relative report path (written unless `dry_run`). */
  report: string;
  since: string | null;
  cases: number;
  case_failures: Array<{ case_id: string; diagnostic_code: string }>;
  suggestions: Array<{
    suggestion_key: string;
    kind: LearningSuggestion['kind'];
    learning_id: string;
    /** `created` / `existing`; `would_queue` on a dry run; `refused` / `failed` when not queued. */
    candidate: 'created' | 'existing' | 'would_queue' | 'refused' | 'failed';
  }>;
  counts: {
    switches: number;
    receipts: number;
    suggestions: number;
    created: number;
    existing: number;
  };
}

function parseSince(value: string | undefined): string | null {
  const since = value?.trim();
  if (!since) return null;
  const ms = Date.parse(since);
  if (!Number.isFinite(ms))
    throw usageError('--since must be a date (YYYY-MM-DD) or ISO timestamp');
  return new Date(ms).toISOString();
}

function subjectLabel(suggestion: LearningSuggestion): string {
  return suggestion.template_id
    ? `${suggestion.template_id}#${suggestion.entry_id ?? ''}`
    : `${suggestion.item}/${suggestion.key}`;
}

function candidateTitle(suggestion: LearningSuggestion): string {
  const subject = subjectLabel(suggestion);
  switch (suggestion.kind) {
    case 'change_org_default':
      return t('customer_decision:learning_title_change_org_default', { subject });
    case 'revise_options':
      return t('customer_decision:learning_title_revise_options', { subject });
    default:
      return t('customer_decision:learning_title_clarify_entry', { subject });
  }
}

function queueSuggestion(
  tenant: string,
  organizationId: string | undefined,
  suggestion: LearningSuggestion & { learning_id: string },
  report: { date: string; ref: string }
): { candidate: 'created' | 'existing' | 'refused'; learning_id: string } {
  const subject = subjectLabel(suggestion);
  const result = withExecutionContext(
    LEDGER_ROLE,
    () =>
      enqueueOperationalLearningCandidateOnce(
        {
          learningId: suggestion.learning_id,
          // One standing candidate per suggestion in the tenant, whatever the
          // date or organization, until the evidence materially changes.
          dedupeKey: `customer-decision-learning:${suggestion.suggestion_key}`,
          signalId: suggestion.learning_id,
          sourceType: 'customer_decision',
          sourceRef: `customer-decision-learning:${suggestion.suggestion_key}`,
          title: candidateTitle(suggestion),
          summary: t('customer_decision:learning_candidate_summary', {
            subject,
            kind: suggestion.kind,
            count: String(suggestion.evidence.count),
            samples: String(suggestion.evidence.samples),
            report: report.ref,
          }),
          evidenceRefs: [report.ref],
          targetKind: 'knowledge_hint',
          tier: 'confidential',
          tenantSlug: tenant,
          metadata: {
            suggestion_key: suggestion.suggestion_key,
            kind: suggestion.kind,
            template_id: suggestion.template_id,
            entry_id: suggestion.entry_id,
            item: suggestion.item,
            key: suggestion.key,
            ...(suggestion.current_org_default !== undefined
              ? { current_org_default: suggestion.current_org_default }
              : {}),
            ...(suggestion.suggested_org_default !== undefined
              ? { suggested_org_default: suggestion.suggested_org_default }
              : {}),
            evidence: suggestion.evidence,
            report_date: report.date,
            report_ref: report.ref,
          },
        },
        { supersedes: (latest) => isMaterialEvidenceChange(latest.metadata, suggestion) }
      ),
    undefined,
    tenant,
    organizationId
  );
  if (!result) return { candidate: 'refused', learning_id: suggestion.learning_id };
  return { candidate: result.created ? 'created' : 'existing', learning_id: result.learning_id };
}

/**
 * The organization default each template entry has now, from the product
 * template (`<template_id>#<entry_id>` → value). A template that cannot be
 * loaded is skipped: the agendas' default stands in.
 */
function templateDefaults(templateIds: readonly string[]): Map<string, unknown> {
  const defaults = new Map<string, unknown>();
  for (const templateId of [...new Set(templateIds)]) {
    try {
      for (const entry of loadDecisionTemplate(templateId).entries) {
        if (entry.org_default)
          defaults.set(`${templateId}#${entry.entry_id}`, entry.org_default.value);
      }
    } catch (error) {
      logger.warn(
        `customer-decision learning: template not read — ${diagnosticCode(error)} | the agendas' default is used | template=${templateId}`
      );
    }
  }
  return defaults;
}

/** `learning --tenant <t> [--since <date>] [--dry-run] [--now <iso>] [--organization-id <id>]` */
export function runLearning(
  opts: Record<string, string>,
  flags: ReadonlySet<string>,
  now: string
): LearningRunResult {
  const tenant = boundTenantOf(opts);
  const at = nowOf(opts, now);
  const since = parseSince(opts.since);
  const dryRun = flags.has('dry-run');
  const organizationId = opts['organization-id']?.trim() || undefined;
  const reportDate = utcDate(at) as string;
  const cases: LearningCaseInput[] = [];
  const failures: LearningRunResult['case_failures'] = [];
  for (const caseId of selectedCaseIds(tenant, opts)) {
    try {
      const location = { tenantSlug: tenant, caseId };
      cases.push(
        asLedgerWriter(tenant, () => ({
          case_id: caseId,
          agendas: listAgendas(location),
          receipts: listReceipts(location),
          switches: readSwitches(location),
        }))
      );
    } catch (error) {
      const code = diagnosticCode(error);
      failures.push({ case_id: caseId, diagnostic_code: code });
      logger.warn(
        `customer-decision learning skipped a case — ${code} | the other cases are counted | case=${caseId}`
      );
    }
  }
  const metrics = buildDecisionLearningMetrics(cases, since ? { since } : {});
  const currentDefaults = templateDefaults(
    metrics.overturn_by_template_entry.flatMap((stat) =>
      stat.template_id ? [stat.template_id] : []
    )
  );
  const suggestions = buildLearningSuggestions(metrics, {}, { currentDefaults }).map(
    (suggestion) => ({
      ...suggestion,
      learning_id: learningCandidateId(tenant, suggestion.suggestion_key, reportDate),
    })
  );
  const reportRef = path
    .relative(pathResolver.rootDir(), learningReportPath(tenant, reportDate))
    .split(path.sep)
    .join('/');
  const result: LearningRunResult = {
    tenant,
    dry_run: dryRun,
    report_date: reportDate,
    report: reportRef,
    since,
    cases: cases.length,
    case_failures: failures,
    suggestions: suggestions.map((suggestion) => ({
      suggestion_key: suggestion.suggestion_key,
      kind: suggestion.kind,
      learning_id: suggestion.learning_id,
      candidate: 'would_queue',
    })),
    counts: {
      switches: metrics.switches,
      receipts: metrics.receipts,
      suggestions: suggestions.length,
      created: 0,
      existing: 0,
    },
  };
  if (dryRun) {
    const standing = standingSuggestions(tenant);
    result.suggestions.forEach((row, index) => {
      const prior = standing.get(row.suggestion_key);
      if (prior && !isMaterialEvidenceChange(prior, suggestions[index])) {
        row.candidate = 'existing';
        row.learning_id = prior.learning_id;
      }
    });
    return result;
  }
  // One learning run per tenant at a time: the standing check against the
  // earlier reports and the queueing cannot interleave with another run.
  return withLockSync(
    `customer-decision-learning-${tenant}`,
    () => queueAndReport(tenant, organizationId, at, since, metrics, suggestions, result),
    LEARNING_LOCK_TIMEOUT_MS
  );
}

const LEARNING_LOCK_TIMEOUT_MS = 30_000;

/** The suggestions the tenant's earlier reports stand for (any date, any organization). */
function standingSuggestions(tenant: string): ReturnType<typeof standingLearningSuggestions> {
  return asLedgerWriter(tenant, () =>
    standingLearningSuggestions(
      listLearningReportDates(tenant).flatMap((date) => {
        try {
          const report = readLearningReport(tenant, date);
          return report ? [report] : [];
        } catch (error) {
          logger.warn(
            `customer-decision learning: earlier report skipped — ${diagnosticCode(error)} | repair or remove it | report=learning-${date}.json`
          );
          return [];
        }
      })
    )
  );
}

function queueAndReport(
  tenant: string,
  organizationId: string | undefined,
  at: string,
  since: string | null,
  metrics: CustomerDecisionLearningReport['metrics'],
  suggestions: CustomerDecisionLearningReport['suggestions'],
  result: LearningRunResult
): LearningRunResult {
  const reportDate = result.report_date;
  const reportRef = result.report;
  const standing = standingSuggestions(tenant);
  const report: CustomerDecisionLearningReport = {
    version: CUSTOMER_DECISION_LEARNING_REPORT_VERSION,
    tenant_slug: tenant,
    report_date: reportDate,
    generated_at: at,
    since,
    thresholds: { ...DEFAULT_LEARNING_THRESHOLDS },
    metrics,
    suggestions,
  };
  // Written first so the candidates' evidence reference exists; rewritten
  // below with what became of each suggestion.
  asLedgerWriter(tenant, () => writeLearningReport(report));
  suggestions.forEach((suggestion, index) => {
    const row = result.suggestions[index];
    const prior = standing.get(suggestion.suggestion_key);
    if (prior && !isMaterialEvidenceChange(prior, suggestion)) {
      // An earlier candidate (any date, any organization, any status) stands.
      row.candidate = 'existing';
      row.learning_id = prior.learning_id;
    } else {
      try {
        const queued = queueSuggestion(tenant, organizationId, suggestion, {
          date: reportDate,
          ref: reportRef,
        });
        row.candidate = queued.candidate;
        row.learning_id = queued.learning_id;
      } catch (error) {
        row.candidate = 'failed';
        logger.warn(
          `customer-decision learning candidate not queued — ${diagnosticCode(error)} | the report is written; re-run customer-decision learning --tenant ${tenant} to retry | learning=${suggestion.learning_id}`
        );
      }
    }
    suggestion.learning_id = row.learning_id;
    suggestion.candidate = row.candidate;
  });
  asLedgerWriter(tenant, () => writeLearningReport(report));
  result.counts.created = result.suggestions.filter((row) => row.candidate === 'created').length;
  result.counts.existing = result.suggestions.filter((row) => row.candidate === 'existing').length;
  audit(tenant, 'learning_report', {
    report_date: reportDate,
    cases: metrics.cases,
    suggestions: result.suggestions.map((row) => ({
      learning_id: row.learning_id,
      kind: row.kind,
      candidate: row.candidate,
    })),
  });
  return result;
}

/**
 * `learning --install --tenant <t> --by user:<member> [--force] [--dry-run]`:
 * promote the weekly learning pipeline template into the tenant's pipeline
 * catalog through `pipeline:promote` (same path as `reminders --install`).
 */
export async function runLearningInstall(
  opts: Record<string, string>,
  flags: ReadonlySet<string>
): Promise<unknown> {
  const tenant = boundTenantOf(opts);
  const by = memberActorId(opts.by);
  const result = await installRepositoryPipelineTemplate(
    [
      '--input',
      LEARNING_PIPELINE_TEMPLATE,
      '--tenant',
      tenant,
      '--name',
      LEARNING_PIPELINE_NAME,
      '--no-llm',
      ...(flags.has('force') ? ['--force'] : []),
      ...(flags.has('dry-run') ? ['--dry-run'] : []),
    ],
    { ingestedBy: by }
  );
  return {
    tenant,
    installed: result.target,
    dry_run: result.dry_run,
    next_steps: result.next_steps,
  };
}
