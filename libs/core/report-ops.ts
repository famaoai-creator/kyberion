/**
 * LE-03 (rollout batch 2): report/verify sweeps as callable library functions,
 * exposed as in-process `system:*` capture ops. Same rationale as
 * reconcile-ops.ts — the logic used to live in scripts reachable only via
 * `system:shell`/`system:exec` wrapper steps, invisible to trace spans and
 * structured-result consumers. The scripts remain as thin CLI shells.
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { auditChain } from './audit-chain.js';
import { GLOBAL_LEDGER_PATH, verifyLedgerIntegrityDetailed } from './ledger.js';
import { listMemoryPromotionCandidates, type MemoryCandidate } from './memory-promotion-queue.js';
import { summarizeHeuristics, type HeuristicReport } from './heuristic-feedback.js';
import { currentScope, type ScopeContext } from './scope-context.js';
import { isRecord } from './foundation/text.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { nowIso } from './foundation/time.js';
import type { TaskModelEffort, TaskModelHint, TaskModelTier } from './reasoning-model-routing.js';

// ─── audit verify (SA-01) ───────────────────────────────────

export interface AuditVerifyCliReport {
  ok: boolean;
  audit: ReturnType<typeof auditChain.verify>;
  ledgers: Array<{
    path: string;
    ok: boolean;
    total: number;
    corrupted: string[];
    missingKey: boolean;
  }>;
  tenantMirrors: {
    ok: boolean;
    findings: string[];
  };
  promotionQueue: {
    ok: boolean;
    total: number;
    audited: number;
    legacyUnlinked: number;
    findings: string[];
  };
}

export function collectAuditVerifyReport(
  input: {
    since?: string;
    ledgers?: string[];
  } = {}
): AuditVerifyCliReport {
  const audit = auditChain.verify({ since: input.since });
  const ledgerPaths = [GLOBAL_LEDGER_PATH, ...(input.ledgers ?? [])].filter(
    (item, index, all) => all.indexOf(item) === index
  );
  const ledgers = ledgerPaths.map((ledgerPath) => {
    const report = verifyLedgerIntegrityDetailed(ledgerPath);
    return {
      path: ledgerPath,
      ok: report.ok,
      total: report.total,
      corrupted: report.corrupted,
      missingKey: report.missingKey,
      ...(safeExistsSync(ledgerPath) ? {} : { missing: true }),
    };
  });
  const tenantMirrors = auditChain.verifyTenantMirrors();
  const auditEntries =
    typeof (auditChain as any).loadAll === 'function' ? (auditChain as any).loadAll() : [];
  const auditById = new Map(
    (auditEntries as Array<{ id?: string; tenantSlug?: string }>).map((entry) => [entry.id, entry])
  );
  const promotionCandidates = listMemoryPromotionCandidates();
  const promotionFindings: string[] = [];
  let audited = 0;
  let legacyUnlinked = 0;
  for (const candidate of promotionCandidates) {
    if (!candidate.audit_ref) {
      legacyUnlinked += 1;
      continue;
    }
    const auditId = candidate.audit_ref.replace(/^audit:/u, '');
    const auditEntry = auditById.get(auditId);
    if (!auditEntry) {
      promotionFindings.push(`${candidate.candidate_id}: missing audit entry ${auditId}`);
      continue;
    }
    if (candidate.scope?.tenant_slug && auditEntry.tenantSlug !== candidate.scope.tenant_slug) {
      promotionFindings.push(
        `${candidate.candidate_id}: audit tenant does not match candidate scope`
      );
      continue;
    }
    audited += 1;
  }
  const promotionQueue = {
    ok: promotionFindings.length === 0,
    total: promotionCandidates.length,
    audited,
    legacyUnlinked,
    findings: promotionFindings,
  };
  return {
    ok:
      audit.corrupted.length === 0 &&
      ledgers.every((ledger) => ledger.ok) &&
      tenantMirrors.ok &&
      promotionQueue.ok,
    audit,
    ledgers,
    tenantMirrors,
    promotionQueue,
  };
}

export function formatAuditVerifyReport(report: AuditVerifyCliReport): string[] {
  const lines = [
    `Audit chain: ${report.audit.corrupted.length === 0 ? 'ok' : 'failed'}; entries=${report.audit.total}; corrupted=${report.audit.corrupted.length}`,
  ];
  if (report.audit.boundaryLimited) {
    lines.push('  - since-boundary: earlier chain continuity was not checked');
  }
  if (report.audit.corrupted.length > 0) {
    lines.push(`  - findings: ${report.audit.corrupted.join(', ')}`);
  }
  for (const ledger of report.ledgers) {
    lines.push(
      `Ledger: ${ledger.ok ? 'ok' : 'failed'}; entries=${ledger.total}; path=${ledger.path}`
    );
    if (ledger.corrupted.length > 0) {
      lines.push(`  - findings: ${ledger.corrupted.join(', ')}`);
    }
    if (ledger.missingKey) {
      lines.push('  - missing HMAC key for one or more ledger entries');
    }
  }
  lines.push(`Tenant mirrors: ${report.tenantMirrors.ok ? 'ok' : 'failed'}`);
  if (report.tenantMirrors.findings.length > 0) {
    lines.push(`  - findings: ${report.tenantMirrors.findings.join(', ')}`);
  }
  lines.push(
    `Promotion queue: ${report.promotionQueue.ok ? 'ok' : 'failed'}; total=${report.promotionQueue.total}; audited=${report.promotionQueue.audited}; legacy_unlinked=${report.promotionQueue.legacyUnlinked}`
  );
  if (report.promotionQueue.findings.length > 0) {
    lines.push(`  - findings: ${report.promotionQueue.findings.join(', ')}`);
  }
  return lines;
}

// ─── memory promotion queue summary (KM-03) ─────────────────

export interface MemoryPromotionQueueSummaryRow {
  candidate_id: string;
  status: string;
  proposed_memory_kind: string;
  sensitivity_tier: string;
  source_ref: string;
  queued_at: string;
  age_days: number;
  occurrences: number;
  ratification_required: boolean;
}

function computeAgeDays(queuedAt: string): number {
  const ts = Date.parse(queuedAt);
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, Math.round(((Date.now() - ts) / (1000 * 60 * 60 * 24)) * 10) / 10);
}

export function summarizeMemoryPromotionQueue(status?: string): MemoryPromotionQueueSummaryRow[] {
  const filterStatus = String(status || '')
    .trim()
    .toLowerCase();
  return listMemoryPromotionCandidates()
    .filter((row) => (filterStatus ? row.status === filterStatus : true))
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at))
    .map((row) => ({
      candidate_id: row.candidate_id,
      status: row.status,
      proposed_memory_kind: row.proposed_memory_kind,
      sensitivity_tier: row.sensitivity_tier,
      source_ref: row.source_ref,
      queued_at: row.queued_at,
      age_days: computeAgeDays(row.queued_at),
      occurrences: typeof row.occurrences === 'number' && row.occurrences > 0 ? row.occurrences : 1,
      ratification_required: row.ratification_required,
    }));
}

export function formatMemoryPromotionQueueMarkdown(rows: MemoryPromotionQueueSummaryRow[]): string {
  const lines = [
    '# Memory Promotion Queue Summary',
    '',
    '| Candidate | Status | Kind | Tier | Occurrences | Age (days) | Ratification | Source |',
    '|---|---|---|---|---:|---:|---|---|',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.candidate_id} | ${row.status} | ${row.proposed_memory_kind} | ${row.sensitivity_tier} | ${row.occurrences} | ${row.age_days.toFixed(1)} | ${row.ratification_required ? 'yes' : 'no'} | ${row.source_ref} |`
    );
  }
  if (rows.length === 0) {
    lines.push('| - | - | - | - | - | - | - | - |');
  }
  lines.push('');
  lines.push(`rows=${rows.length}`);
  return lines.join('\n');
}

export interface MemoryPromotionQueueSummaryResult {
  rows: MemoryPromotionQueueSummaryRow[];
  markdown: string;
  output_path?: string;
}

/** Op-shaped entry: summarize and optionally persist (markdown) to output_path. */
export function runMemoryPromotionQueueSummary(
  input: { status?: string; output_path?: string } = {}
): MemoryPromotionQueueSummaryResult {
  const rows = summarizeMemoryPromotionQueue(input.status);
  const markdown = formatMemoryPromotionQueueMarkdown(rows);
  let outputPath: string | undefined;
  if (input.output_path) {
    outputPath = assertSafeRepositoryPath(pathResolver.resolve(input.output_path), {
      allowMissingLeaf: true,
    });
    safeWriteFile(outputPath, `${markdown}\n`);
  }
  return { rows, markdown, ...(outputPath ? { output_path: outputPath } : {}) };
}

// ─── knowledge validation sweep (KO-17/19) ─────────────────

export interface KnowledgeValidationFinding {
  code: 'legacy_unscoped_candidate' | 'missing_tenant_scope' | 'tenant_reference_mismatch';
  candidate_id: string;
  detail: string;
  severity: 'warning' | 'error';
}

export interface KnowledgeValidationSweepResult {
  generated_at: string;
  scope?: ScopeContext;
  status: 'ok' | 'attention';
  heuristics: HeuristicReport;
  promotion_queue: {
    visible_count: number;
    queued_count: number;
    legacy_unscoped_count: number;
    scoped_count: number;
    audited_count: number;
    missing_audit_ref_count: number;
  };
  findings: KnowledgeValidationFinding[];
}

function candidateVisibleInScope(candidate: MemoryCandidate, scope?: ScopeContext): boolean {
  if (!scope?.tenant_slug) return true;
  return candidate.scope?.tenant_slug === scope.tenant_slug;
}

function tenantReferenceMismatch(candidate: MemoryCandidate): boolean {
  const tenant = candidate.scope?.tenant_slug;
  if (!tenant) return false;
  return [...candidate.evidence_refs, candidate.source_ref, candidate.promoted_ref || ''].some(
    (ref) => {
      const match = ref.match(/knowledge\/confidential\/([^/]+)/u);
      return Boolean(match && match[1] !== tenant);
    }
  );
}

/**
 * Read-only weekly hygiene sweep for feedback-derived knowledge. It reports
 * legacy records and scope violations but never changes queue status or
 * demotes knowledge. Tenant-scoped callers only see their own queue rows.
 */
export function runKnowledgeValidationSweep(
  input: { scope?: ScopeContext } = {}
): KnowledgeValidationSweepResult {
  const scope = input.scope ?? currentScope();
  const visible = listMemoryPromotionCandidates().filter((candidate) =>
    candidateVisibleInScope(candidate, scope)
  );
  const findings: KnowledgeValidationFinding[] = [];
  for (const candidate of visible) {
    if (!candidate.scope) {
      findings.push({
        code: 'legacy_unscoped_candidate',
        candidate_id: candidate.candidate_id,
        detail: 'promotion queue record has no scope envelope; review before promotion',
        severity: 'warning',
      });
      continue;
    }
    if (candidate.scope.tier === 'confidential' && !candidate.scope.tenant_slug) {
      findings.push({
        code: 'missing_tenant_scope',
        candidate_id: candidate.candidate_id,
        detail: 'confidential promotion candidate is missing tenant_slug',
        severity: 'error',
      });
    }
    if (tenantReferenceMismatch(candidate)) {
      findings.push({
        code: 'tenant_reference_mismatch',
        candidate_id: candidate.candidate_id,
        detail: 'evidence or promoted reference names a different confidential tenant',
        severity: 'error',
      });
    }
  }
  const queued = visible.filter((candidate) => candidate.status === 'queued');
  const errors = findings.some((finding) => finding.severity === 'error');
  return {
    generated_at: nowIso(),
    ...(scope ? { scope } : {}),
    status: errors ? 'attention' : 'ok',
    heuristics: summarizeHeuristics(10),
    promotion_queue: {
      visible_count: visible.length,
      queued_count: queued.length,
      legacy_unscoped_count: visible.filter((candidate) => !candidate.scope).length,
      scoped_count: visible.filter((candidate) => Boolean(candidate.scope)).length,
      audited_count: visible.filter((candidate) => Boolean(candidate.audit_ref)).length,
      missing_audit_ref_count: visible.filter((candidate) => !candidate.audit_ref).length,
    },
    findings,
  };
}

// ─── task model routing summary (MO-05) ─────────────────────

interface TaskIssueEvent {
  event_type?: string;
  mission_id?: string;
  task_id?: string;
  agent_id?: string;
  team_role?: string;
  payload?: {
    task_model_hint?: TaskModelHint;
  };
  scope?: {
    tenant_slug?: string;
    tenant_id?: string;
  };
}

interface SupervisorAskCompletedEvent {
  decision?: string;
  agent_id?: string;
  model_id?: string;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  scope?: {
    tenant_slug?: string;
    tenant_id?: string;
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeScope(value: unknown): { tenant_slug?: string; tenant_id?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const tenantSlug = optionalString(value.tenant_slug);
  const tenantId = optionalString(value.tenant_id);
  if (tenantSlug === undefined && tenantId === undefined) return undefined;
  return {
    ...(tenantSlug !== undefined ? { tenant_slug: tenantSlug } : {}),
    ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
  };
}

function normalizeTaskModelHint(value: unknown): TaskModelHint | null {
  if (!isRecord(value)) return null;
  const tier = value.tier;
  const effort = value.effort;
  const modelId = optionalString(value.model_id);
  if (
    (tier !== 'small' && tier !== 'standard' && tier !== 'large') ||
    (effort !== 'low' && effort !== 'medium' && effort !== 'high') ||
    !modelId
  ) {
    return null;
  }
  const executionTier = value.execution_tier;
  return {
    tier,
    effort,
    model_id: modelId,
    route_reason: optionalString(value.route_reason) ?? '',
    ...(executionTier === 'fast' || executionTier === 'standard' || executionTier === 'deep'
      ? { execution_tier: executionTier }
      : {}),
  };
}

function normalizeTaskIssueEvent(value: unknown): TaskIssueEvent | null {
  if (!isRecord(value)) return null;
  const payload = isRecord(value.payload)
    ? (() => {
        const taskModelHint = normalizeTaskModelHint(value.payload.task_model_hint);
        return taskModelHint ? { task_model_hint: taskModelHint } : undefined;
      })()
    : undefined;
  const scope = normalizeScope(value.scope);
  return {
    ...(optionalString(value.event_type) !== undefined
      ? { event_type: optionalString(value.event_type) }
      : {}),
    ...(optionalString(value.mission_id) !== undefined
      ? { mission_id: optionalString(value.mission_id) }
      : {}),
    ...(optionalString(value.task_id) !== undefined
      ? { task_id: optionalString(value.task_id) }
      : {}),
    ...(optionalString(value.agent_id) !== undefined
      ? { agent_id: optionalString(value.agent_id) }
      : {}),
    ...(optionalString(value.team_role) !== undefined
      ? { team_role: optionalString(value.team_role) }
      : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

function normalizeSupervisorAskCompletedEvent(value: unknown): SupervisorAskCompletedEvent | null {
  if (!isRecord(value)) return null;
  const scope = normalizeScope(value.scope);
  return {
    ...(optionalString(value.decision) !== undefined
      ? { decision: optionalString(value.decision) }
      : {}),
    ...(optionalString(value.agent_id) !== undefined
      ? { agent_id: optionalString(value.agent_id) }
      : {}),
    ...(optionalString(value.model_id) !== undefined
      ? { model_id: optionalString(value.model_id) }
      : {}),
    ...(optionalFiniteNumber(value.duration_ms) !== undefined
      ? { duration_ms: optionalFiniteNumber(value.duration_ms) }
      : {}),
    ...(optionalFiniteNumber(value.input_tokens) !== undefined
      ? { input_tokens: optionalFiniteNumber(value.input_tokens) }
      : {}),
    ...(optionalFiniteNumber(value.output_tokens) !== undefined
      ? { output_tokens: optionalFiniteNumber(value.output_tokens) }
      : {}),
    ...(optionalFiniteNumber(value.total_tokens) !== undefined
      ? { total_tokens: optionalFiniteNumber(value.total_tokens) }
      : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

/**
 * Shared observability is intentionally cross-mission, so a tenant-scoped
 * report must filter both streams before correlating them. Missing scope is
 * legacy data and is not safe to expose to a tenant-scoped caller.
 */
function eventVisibleToScope(
  event: { scope?: { tenant_slug?: string; tenant_id?: string }; tenant_slug?: string },
  scope: ScopeContext
): boolean {
  if (!scope.tenant_slug) return true;
  const eventTenant = event.scope?.tenant_slug || event.scope?.tenant_id || event.tenant_slug;
  return eventTenant === scope.tenant_slug;
}

export interface TaskRoutingSample {
  mission_id: string;
  task_id: string;
  team_role: string;
  planned_tier: TaskModelTier;
  planned_effort: TaskModelEffort;
  planned_model_id: string;
  actual_model_id?: string;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  rework_count: number;
}

export interface TaskRoutingSummaryRow {
  team_role: string;
  planned_tier: TaskModelTier;
  samples: number;
  avg_duration_ms: number;
  avg_input_tokens: number;
  avg_output_tokens: number;
  avg_total_tokens: number;
  avg_rework_count: number;
  actual_models: string[];
}

function parseJsonl(raw: string): unknown[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [parseSafeJsonInput(line, 'report JSONL entry')];
      } catch {
        return [];
      }
    });
}

export function buildTaskRoutingSamples(
  taskEvents: TaskIssueEvent[],
  supervisorEvents: SupervisorAskCompletedEvent[]
): TaskRoutingSample[] {
  const issueCounts = new Map<string, number>();
  const samplesByAgent = new Map<string, TaskRoutingSample[]>();
  const samples: TaskRoutingSample[] = [];

  for (const event of taskEvents) {
    if (event.event_type !== 'task_issued') continue;
    const hint = event.payload?.task_model_hint;
    if (
      !event.mission_id ||
      !event.task_id ||
      !event.team_role ||
      !event.agent_id ||
      !hint ||
      (hint.tier !== 'small' && hint.tier !== 'standard' && hint.tier !== 'large')
    ) {
      continue;
    }
    const key = `${event.mission_id}:${event.task_id}`;
    const previousCount = issueCounts.get(key) || 0;
    issueCounts.set(key, previousCount + 1);
    const sample: TaskRoutingSample = {
      mission_id: event.mission_id,
      task_id: event.task_id,
      team_role: event.team_role,
      planned_tier: hint.tier,
      planned_effort: hint.effort,
      planned_model_id: hint.model_id,
      rework_count: previousCount,
    };
    samples.push(sample);
    const queued = samplesByAgent.get(event.agent_id) || [];
    queued.push(sample);
    samplesByAgent.set(event.agent_id, queued);
  }

  for (const event of supervisorEvents) {
    if (event.decision !== 'agent_runtime_ask_completed' || !event.agent_id) continue;
    const queued = samplesByAgent.get(event.agent_id);
    if (!queued || queued.length === 0) continue;
    const sample = queued.shift()!;
    sample.actual_model_id = event.model_id || sample.actual_model_id;
    sample.duration_ms = event.duration_ms;
    sample.input_tokens = event.input_tokens;
    sample.output_tokens = event.output_tokens;
    sample.total_tokens = event.total_tokens;
  }

  return samples;
}

export function summarizeTaskRouting(samples: TaskRoutingSample[]): TaskRoutingSummaryRow[] {
  const groups = new Map<string, TaskRoutingSample[]>();

  for (const sample of samples) {
    const key = `${sample.team_role}::${sample.planned_tier}`;
    const list = groups.get(key) || [];
    list.push(sample);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .map(([key, list]) => {
      const [team_role, planned_tier] = key.split('::') as [string, TaskModelTier];
      const totals = list.reduce(
        (acc, sample) => {
          acc.duration += sample.duration_ms || 0;
          acc.inputTokens += sample.input_tokens || 0;
          acc.outputTokens += sample.output_tokens || 0;
          acc.totalTokens += sample.total_tokens || 0;
          acc.rework += sample.rework_count;
          if (sample.actual_model_id) acc.models.add(sample.actual_model_id);
          return acc;
        },
        {
          duration: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          rework: 0,
          models: new Set<string>(),
        }
      );
      const count = list.length || 1;
      return {
        team_role,
        planned_tier,
        samples: list.length,
        avg_duration_ms: Math.round(totals.duration / count),
        avg_input_tokens: Math.round(totals.inputTokens / count),
        avg_output_tokens: Math.round(totals.outputTokens / count),
        avg_total_tokens: Math.round(totals.totalTokens / count),
        avg_rework_count: Math.round((totals.rework / count) * 100) / 100,
        actual_models: Array.from(totals.models).sort(),
      };
    })
    .sort(
      (left, right) =>
        left.team_role.localeCompare(right.team_role) ||
        left.planned_tier.localeCompare(right.planned_tier)
    );
}

export function writeTaskRoutingSummary(input: {
  samples: TaskRoutingSample[];
  rows: TaskRoutingSummaryRow[];
  outputPath: string;
}): void {
  const outputPath = assertSafeRepositoryPath(input.outputPath, { allowMissingLeaf: true });
  safeWriteFile(
    outputPath,
    JSON.stringify(
      {
        samples: input.samples,
        rows: input.rows,
      },
      null,
      2
    ),
    { mkdir: true, encoding: 'utf8' }
  );
}

export interface TaskModelRoutingSummaryResult {
  samples: TaskRoutingSample[];
  rows: TaskRoutingSummaryRow[];
  output_path?: string;
}

function readJsonlEvents(filePath: string): unknown[] {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath)) return [];
  return parseJsonl(safeReadFile(safePath, { encoding: 'utf8' }) as string);
}

/** Op-shaped entry: collect samples from the observability JSONL streams. */
export function runTaskModelRoutingSummary(
  input: {
    task_events_path?: string;
    supervisor_events_path?: string;
    output_path?: string;
  } = {}
): TaskModelRoutingSummaryResult {
  const scope = currentScope();
  const taskEventsPath =
    input.task_events_path ||
    pathResolver.shared(path.join('observability', 'mission-control', 'task-events.jsonl'));
  const supervisorEventsPath =
    input.supervisor_events_path ||
    pathResolver.shared(
      path.join('observability', 'mission-control', 'agent-runtime-supervisor-events.jsonl')
    );

  const samples = buildTaskRoutingSamples(
    readJsonlEvents(taskEventsPath)
      .map(normalizeTaskIssueEvent)
      .filter((event): event is TaskIssueEvent => event !== null)
      .filter((event) => eventVisibleToScope(event, scope)),
    readJsonlEvents(supervisorEventsPath)
      .map(normalizeSupervisorAskCompletedEvent)
      .filter((event): event is SupervisorAskCompletedEvent => event !== null)
      .filter((event) => eventVisibleToScope(event, scope))
  );
  const rows = summarizeTaskRouting(samples);
  let outputPath: string | undefined;
  if (input.output_path) {
    outputPath = assertSafeRepositoryPath(pathResolver.resolve(input.output_path), {
      allowMissingLeaf: true,
    });
    writeTaskRoutingSummary({ samples, rows, outputPath });
  }
  return { samples, rows, ...(outputPath ? { output_path: outputPath } : {}) };
}
