import type { ValidateFunction } from 'ajv';
import * as path from 'node:path';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { compileSchema } from './foundation/ajv.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import { readTextFile } from './foundation/text.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';
import type { DistillCandidateRecord } from './distill-candidate-registry.js';
import type { OrganizationWorkLoopSummary } from './work-design.js';
import type { MemoryScopeEnvelope } from './memory-scope.js';
import { logger } from './core.js';
import {
  resolvePromotedReportAudience,
  resolvePromotedReportOutputFormat,
  resolvePromotedReportTemplateSections,
} from './promoted-report-template-policy.js';

interface PromotedMemoryRecordBase {
  record_id: string;
  kind: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';
  tier: 'personal' | 'confidential' | 'public';
  title: string;
  summary: string;
  candidate_id: string;
  supersedes?: string;
  superseded_by?: string;
  project_id?: string;
  track_id?: string;
  track_name?: string;
  task_session_id?: string;
  specialist_id?: string;
  locale?: string;
  work_loop?: OrganizationWorkLoopSummary;
  artifact_ids?: string[];
  evidence_refs?: string[];
  created_at: string;
}

export interface PromotedPatternRecord extends PromotedMemoryRecordBase {
  kind: 'pattern';
  applicability: string[];
  reusable_steps: string[];
  expected_outcome: string;
}

export interface PromotedSopRecord extends PromotedMemoryRecordBase {
  kind: 'sop_candidate';
  procedure_steps: string[];
  safety_notes: string[];
  escalation_conditions: string[];
}

export interface PromotedKnowledgeHintRecord extends PromotedMemoryRecordBase {
  kind: 'knowledge_hint';
  hint_scope: string;
  hint_triggers: string[];
  recommended_refs: string[];
}

export interface PromotedReportTemplateRecord extends PromotedMemoryRecordBase {
  kind: 'report_template';
  template_sections: string[];
  audience: string;
  output_format: string;
}

export type PromotedMemoryRecord =
  | PromotedPatternRecord
  | PromotedSopRecord
  | PromotedKnowledgeHintRecord
  | PromotedReportTemplateRecord;

const validatorCache = new Map<string, ValidateFunction>();
// Test isolation (env override): the distill E2E rewrites HINTS.md, and a
// parallel catalog-integrity test can observe the mid-test dirty state.
// Overriding the paths lets tests run against a scratch copy.
function tenantEvolutionRoot(scope?: MemoryScopeEnvelope): string | undefined {
  const tenant = scope?.tier === 'confidential' ? scope.tenant_slug?.trim() : undefined;
  if (
    !tenant ||
    tenant.includes('/') ||
    tenant.includes('\\') ||
    tenant === '.' ||
    tenant === '..'
  ) {
    return undefined;
  }
  // KYBERION_HINTS_PATH is a legacy/global file override used by tests and
  // the shared governance lane. It must never become the parent of a tenant
  // namespace (a file path would otherwise turn into
  // `<HINTS_PATH>/<tenant>/evolution`). Tenant promotion always resolves from
  // the authoritative confidential knowledge root.
  return assertSafeRepositoryPath(
    path.join(pathResolver.knowledge('confidential'), tenant, 'evolution'),
    { allowMissingLeaf: true }
  );
}

function safeOverridePath(override: string | undefined, fallback: string): string {
  if (override) {
    try {
      return assertSafeRepositoryPath(pathResolver.rootResolve(override), {
        allowMissingLeaf: true,
      });
    } catch {
      // An optional test/runtime override must never widen the write surface.
    }
  }
  return assertSafeRepositoryPath(fallback, { allowMissingLeaf: true });
}

function resolveHintsPath(scope?: MemoryScopeEnvelope): string {
  const tenantRoot = tenantEvolutionRoot(scope);
  if (tenantRoot)
    return assertSafeRepositoryPath(path.join(tenantRoot, 'HINTS.md'), {
      allowMissingLeaf: true,
    });
  const override = getRegisteredEnvText('KYBERION_HINTS_PATH');
  return safeOverridePath(override, pathResolver.knowledge('product/governance/HINTS.md'));
}
function resolveHintsArchiveDir(scope?: MemoryScopeEnvelope): string {
  const tenantRoot = tenantEvolutionRoot(scope);
  if (tenantRoot)
    return assertSafeRepositoryPath(path.join(tenantRoot, 'hints-archive'), {
      allowMissingLeaf: true,
    });
  const override = getRegisteredEnvText('KYBERION_HINTS_ARCHIVE_DIR');
  return safeOverridePath(override, pathResolver.knowledge('product/hints/archive'));
}
const HINTS_MARKER =
  '<!-- Distillation pipeline will append structured hint blocks below this line -->';
const HINTS_MAX_SECTIONS = 50;

type PromotedMemoryExecutionRole = 'mission_controller' | 'chronos_gateway';

function withPromotedMemoryExecutionContext<T>(role: PromotedMemoryExecutionRole, fn: () => T): T {
  return withExecutionContext(role, fn, 'ecosystem_architect');
}

function schemaPathForKind(kind: PromotedMemoryRecord['kind']): string {
  switch (kind) {
    case 'pattern':
      return pathResolver.knowledge('product/schemas/generated-pattern-record.schema.json');
    case 'sop_candidate':
      return pathResolver.knowledge('product/schemas/generated-sop-record.schema.json');
    case 'knowledge_hint':
      return pathResolver.knowledge('product/schemas/generated-knowledge-hint-record.schema.json');
    case 'report_template':
      return pathResolver.knowledge('product/schemas/generated-report-template-record.schema.json');
  }
}

function ensureValidator(kind: PromotedMemoryRecord['kind']): ValidateFunction {
  const cached = validatorCache.get(kind);
  if (cached) return cached;
  const validator = compileSchema(schemaPathForKind(kind));
  validatorCache.set(kind, validator);
  return validator;
}

function logicalDirFor(input: {
  kind: PromotedMemoryRecord['kind'];
  tier: PromotedMemoryRecord['tier'];
  scope?: MemoryScopeEnvelope;
}): string {
  const tenantRoot = tenantEvolutionRoot(input.scope);
  if (tenantRoot) {
    const kindDir =
      input.kind === 'pattern'
        ? 'patterns'
        : input.kind === 'sop_candidate'
          ? 'operations'
          : input.kind === 'knowledge_hint'
            ? 'wisdom'
            : 'templates';
    return `${tenantRoot}/${kindDir}`;
  }
  switch (input.kind) {
    case 'pattern':
      return `knowledge/${input.tier}/common/patterns/generated`;
    case 'sop_candidate':
      return `knowledge/${input.tier}/common/operations/generated`;
    case 'knowledge_hint':
      return `knowledge/${input.tier}/common/wisdom/generated`;
    case 'report_template':
      return `knowledge/${input.tier}/common/templates/generated`;
  }
}

function normalizeLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|;/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function fallbackSteps(summary: string, defaults: string[]): string[] {
  const lines = summary
    .split(/[。.!?\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : defaults;
}

function buildMarkdown(record: PromotedMemoryRecord): string {
  const frontmatter = [
    `---`,
    `record_id: ${record.record_id}`,
    `kind: ${record.kind}`,
    `tier: ${record.tier}`,
    `candidate_id: ${record.candidate_id}`,
    `supersedes: ${record.supersedes || ''}`,
    `superseded_by: ${record.superseded_by || ''}`,
    `project_id: ${record.project_id || ''}`,
    `task_session_id: ${record.task_session_id || ''}`,
    `specialist_id: ${record.specialist_id || ''}`,
    `locale: ${record.locale || ''}`,
    `created_at: ${record.created_at}`,
    `---`,
    ``,
    `# ${record.title}`,
    ``,
    record.summary,
    ``,
  ];
  if (record.kind === 'pattern') {
    return [
      ...frontmatter,
      `## Applicability`,
      ``,
      ...record.applicability.map((item) => `- ${item}`),
      ``,
      `## Reusable Steps`,
      ``,
      ...record.reusable_steps.map((item, index) => `${index + 1}. ${item}`),
      ``,
      `## Expected Outcome`,
      ``,
      record.expected_outcome,
      ``,
      `## Evidence`,
      ``,
      ...(record.evidence_refs || []).map((ref) => `- ${ref}`),
      ``,
      `## Artifacts`,
      ``,
      ...(record.artifact_ids || []).map((id) => `- ${id}`),
    ].join('\n');
  }
  if (record.kind === 'sop_candidate') {
    return [
      ...frontmatter,
      `## Procedure Steps`,
      ``,
      ...record.procedure_steps.map((item, index) => `${index + 1}. ${item}`),
      ``,
      `## Safety Notes`,
      ``,
      ...record.safety_notes.map((item) => `- ${item}`),
      ``,
      `## Escalation Conditions`,
      ``,
      ...record.escalation_conditions.map((item) => `- ${item}`),
      ``,
      `## Evidence`,
      ``,
      ...(record.evidence_refs || []).map((ref) => `- ${ref}`),
      ``,
      `## Artifacts`,
      ``,
      ...(record.artifact_ids || []).map((id) => `- ${id}`),
    ].join('\n');
  }
  if (record.kind === 'knowledge_hint') {
    return [
      ...frontmatter,
      `## Hint Scope`,
      ``,
      record.hint_scope,
      ``,
      `## Trigger Phrases`,
      ``,
      ...record.hint_triggers.map((item) => `- ${item}`),
      ``,
      `## Recommended References`,
      ``,
      ...record.recommended_refs.map((item) => `- ${item}`),
      ``,
      `## Evidence`,
      ``,
      ...(record.evidence_refs || []).map((ref) => `- ${ref}`),
      ``,
      `## Artifacts`,
      ``,
      ...(record.artifact_ids || []).map((id) => `- ${id}`),
    ].join('\n');
  }
  return [
    ...frontmatter,
    `## Audience`,
    ``,
    record.audience,
    ``,
    `## Output Format`,
    ``,
    record.output_format,
    ``,
    `## Template Sections`,
    ``,
    ...record.template_sections.map((item, index) => `${index + 1}. ${item}`),
    ``,
    `## Evidence`,
    ``,
    ...(record.evidence_refs || []).map((ref) => `- ${ref}`),
    ``,
    `## Artifacts`,
    ``,
    ...(record.artifact_ids || []).map((id) => `- ${id}`),
  ].join('\n');
}

function buildHintsBlock(record: PromotedKnowledgeHintRecord): string {
  return [
    `## ${record.record_id} (${record.created_at.slice(0, 10)})`,
    '',
    record.summary,
    '',
    `source_ref: ${record.candidate_id}`,
    `evidence_refs:`,
    ...record.evidence_refs.map((ref) => `- ${ref}`),
    '',
  ].join('\n');
}

function splitHintsBlocks(raw: string): string[] {
  const markerIndex = raw.indexOf(HINTS_MARKER);
  if (markerIndex < 0) return [];
  const tail = raw.slice(markerIndex + HINTS_MARKER.length).trim();
  if (!tail) return [];
  return tail
    .split(/\n{2,}(?=## )/u)
    .map((block) => block.trim())
    .filter(Boolean);
}

function buildHintsArchivePath(
  record: PromotedKnowledgeHintRecord,
  scope?: MemoryScopeEnvelope
): string {
  const stamp = record.created_at.replace(/[:.]/gu, '-');
  return `${resolveHintsArchiveDir(scope)}/${stamp}-${record.record_id}.md`;
}

function archiveGovernanceHintBlocks(
  blocks: string[],
  record: PromotedKnowledgeHintRecord,
  scope?: MemoryScopeEnvelope
): void {
  if (blocks.length === 0) return;
  const archivePath = buildHintsArchivePath(record, scope);
  if (!safeExistsSync(resolveHintsArchiveDir(scope)))
    safeMkdir(resolveHintsArchiveDir(scope), { recursive: true });
  const content = [
    '# Archived Operational Hints',
    '',
    `archived_at: ${record.created_at}`,
    `source: ${resolveHintsPath(scope)}`,
    `archived_sections: ${blocks.length}`,
    '',
    ...blocks,
  ].join('\n\n');
  safeWriteFile(archivePath, `${content.replace(/\n?$/, '\n')}`);
}

function buildLiveHintsDocument(existing: string, retainedBlocks: string[]): string {
  const markerIndex = existing.indexOf(HINTS_MARKER);
  const baseDocument =
    markerIndex >= 0
      ? existing.slice(0, markerIndex + HINTS_MARKER.length).trimEnd()
      : [
          '# Operational Hints',
          '',
          '> **Generated by** `pipelines/fragments/memory-distillation.json` (via `volatile-gc` → `memory-promotion-queue`).',
          '> Do not edit manually — content is overwritten by the distillation pipeline.',
          '> **Purpose**: Condensed operational learnings from recent missions and volatile working-memory faces,',
          '> surfaced here so Recovery and Alignment phases can read relevant hints without full knowledge search.',
          '',
          HINTS_MARKER,
        ].join('\n');
  if (retainedBlocks.length === 0) {
    return `${baseDocument.trimEnd()}\n`;
  }
  return `${baseDocument.trimEnd()}\n\n${retainedBlocks.join('\n\n')}\n`;
}

function existingRegularPromotedMemoryFile(filePath: string, label: string): string | null {
  if (!safeExistsSync(filePath)) return null;
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`[PROMOTED_MEMORY_RESOURCE] ${label} must be a regular file: ${filePath}`);
  }
  return filePath;
}

function appendGovernanceHintRecord(
  record: PromotedKnowledgeHintRecord,
  scope?: MemoryScopeEnvelope
): void {
  const block = buildHintsBlock(record);
  const hintsPath = resolveHintsPath(scope);
  const existingHintsPath = existingRegularPromotedMemoryFile(hintsPath, 'hints')
    ? hintsPath
    : null;
  const existing = existingHintsPath
    ? readTextFile(existingHintsPath)
    : [
        '# Operational Hints',
        '',
        '> **Generated by** `pipelines/fragments/memory-distillation.json` (via `volatile-gc` → `memory-promotion-queue`).',
        '> Do not edit manually — content is overwritten by the distillation pipeline.',
        '> **Purpose**: Condensed operational learnings from recent missions and volatile working-memory faces,',
        '> surfaced here so Recovery and Alignment phases can read relevant hints without full knowledge search.',
        '',
        HINTS_MARKER,
        '',
      ].join('\n');

  const blocks = splitHintsBlocks(existing);
  blocks.push(block);

  const overflowCount = Math.max(0, blocks.length - HINTS_MAX_SECTIONS);
  const overflowBlocks = overflowCount > 0 ? blocks.slice(0, overflowCount) : [];
  const retainedBlocks = overflowCount > 0 ? blocks.slice(overflowCount) : blocks;

  archiveGovernanceHintBlocks(overflowBlocks, record, scope);
  const hintsDir = pathResolver.rootResolve(path.dirname(hintsPath));
  if (!safeExistsSync(hintsDir)) safeMkdir(hintsDir, { recursive: true });
  safeWriteFile(hintsPath, buildLiveHintsDocument(existing, retainedBlocks));
}

function resolvePromotedRecordPath(ref: string): string | null {
  const normalized = String(ref || '').trim();
  if (!normalized) return null;
  if (normalized.endsWith('.md') || normalized.includes('/')) {
    let abs: string;
    try {
      abs = assertSafeRepositoryPath(pathResolver.resolve(normalized), {
        allowMissingLeaf: true,
      });
    } catch {
      return null;
    }
    return existingRegularPromotedMemoryFile(abs, 'promoted record');
  }
  const kinds = ['pattern', 'sop_candidate', 'knowledge_hint', 'report_template'] as const;
  const tiers = ['personal', 'confidential', 'public'] as const;
  for (const tier of tiers) {
    for (const kind of kinds) {
      const dir =
        kind === 'pattern'
          ? `knowledge/${tier}/common/patterns/generated`
          : kind === 'sop_candidate'
            ? `knowledge/${tier}/common/operations/generated`
            : kind === 'knowledge_hint'
              ? `knowledge/${tier}/common/wisdom/generated`
              : `knowledge/${tier}/common/templates/generated`;
      const abs = pathResolver.resolve(`${dir}/${normalized}.md`);
      const existing = existingRegularPromotedMemoryFile(abs, 'promoted record');
      if (existing) return existing;
    }
  }
  return null;
}

function updateFrontmatterField(absPath: string, key: string, value: string): void {
  const existingPath = existingRegularPromotedMemoryFile(absPath, 'promoted record');
  if (!existingPath) return;
  const raw = readTextFile(existingPath);
  const lines = raw.split(/\r?\n/);
  const start = lines.indexOf('---');
  if (start < 0) return;
  const end = lines.indexOf('---', start + 1);
  if (end < 0) return;
  const nextValue = `${key}: ${value}`;
  let updated = false;
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i].startsWith(`${key}:`)) {
      lines[i] = nextValue;
      updated = true;
      break;
    }
  }
  if (!updated) lines.splice(end, 0, nextValue);
  safeWriteFile(existingPath, `${lines.join('\n').replace(/\n?$/, '\n')}`);
}

function backlinkSupersededRecord(record: PromotedMemoryRecord): void {
  const targetRef = record.supersedes;
  if (!targetRef) return;
  const targetPath = resolvePromotedRecordPath(targetRef);
  if (!targetPath) {
    logger.warn(
      `[promoted-memory] superseded record not found for ${record.record_id}: ${targetRef}`
    );
    return;
  }
  updateFrontmatterField(targetPath, 'superseded_by', record.record_id);
}

export function buildPromotedMemoryRecord(candidate: DistillCandidateRecord): PromotedMemoryRecord {
  if (candidate.target_kind === 'procedure') {
    throw new Error(
      'Procedure candidates use the procedure promotion gate, not promoted-memory records'
    );
  }
  const tier =
    candidate.tier === 'personal' || candidate.tier === 'public' ? candidate.tier : 'confidential';
  const metadata = candidate.metadata || {};
  const base: PromotedMemoryRecordBase = {
    record_id: candidate.candidate_id,
    kind: candidate.target_kind,
    tier,
    title: candidate.title,
    summary: candidate.summary,
    candidate_id: candidate.candidate_id,
    supersedes:
      typeof metadata.supersedes === 'string' && metadata.supersedes.trim()
        ? metadata.supersedes.trim()
        : undefined,
    superseded_by:
      typeof metadata.superseded_by === 'string' && metadata.superseded_by.trim()
        ? metadata.superseded_by.trim()
        : undefined,
    project_id: candidate.project_id,
    track_id: candidate.track_id,
    track_name: candidate.track_name,
    task_session_id: candidate.task_session_id,
    specialist_id: candidate.specialist_id,
    locale: candidate.locale,
    work_loop: candidate.work_loop,
    artifact_ids: candidate.artifact_ids,
    evidence_refs: candidate.evidence_refs,
    created_at: nowIso(),
  };
  if (candidate.target_kind === 'pattern') {
    return {
      ...base,
      kind: 'pattern',
      applicability:
        normalizeLines(metadata.applicability).length > 0
          ? normalizeLines(metadata.applicability)
          : ['repeatable delivery work', candidate.specialist_id || 'general specialist'],
      reusable_steps:
        normalizeLines(metadata.reusable_steps).length > 0
          ? normalizeLines(metadata.reusable_steps)
          : fallbackSteps(candidate.summary, [
              'review the prior outcome',
              'adapt the pattern to the active request',
              'verify the delivered result',
            ]),
      expected_outcome:
        typeof metadata.expected_outcome === 'string' && metadata.expected_outcome.trim()
          ? metadata.expected_outcome.trim()
          : candidate.summary,
    };
  }
  if (candidate.target_kind === 'sop_candidate') {
    return {
      ...base,
      kind: 'sop_candidate',
      procedure_steps:
        normalizeLines(metadata.procedure_steps).length > 0
          ? normalizeLines(metadata.procedure_steps)
          : fallbackSteps(candidate.summary, [
              'inspect the current state',
              'apply the standard operator action',
              'confirm the outcome and capture evidence',
            ]),
      safety_notes:
        normalizeLines(metadata.safety_notes).length > 0
          ? normalizeLines(metadata.safety_notes)
          : [
              'Require approval before irreversible or high-risk actions.',
              'Capture evidence before and after the action.',
            ],
      escalation_conditions:
        normalizeLines(metadata.escalation_conditions).length > 0
          ? normalizeLines(metadata.escalation_conditions)
          : [
              'Unexpected runtime failure',
              'Policy or approval mismatch',
              'Result does not match the expected state',
            ],
    };
  }
  if (candidate.target_kind === 'knowledge_hint') {
    return {
      ...base,
      kind: 'knowledge_hint',
      hint_scope:
        typeof metadata.hint_scope === 'string' && metadata.hint_scope.trim()
          ? metadata.hint_scope.trim()
          : candidate.specialist_id || 'general reasoning',
      hint_triggers:
        normalizeLines(metadata.hint_triggers).length > 0
          ? normalizeLines(metadata.hint_triggers)
          : [candidate.title, candidate.summary].filter(Boolean),
      recommended_refs:
        normalizeLines(metadata.recommended_refs).length > 0
          ? normalizeLines(metadata.recommended_refs)
          : candidate.evidence_refs || [],
    };
  }
  return {
    ...base,
    kind: 'report_template',
    template_sections:
      normalizeLines(metadata.template_sections).length > 0
        ? normalizeLines(metadata.template_sections)
        : resolvePromotedReportTemplateSections(),
    audience:
      typeof metadata.audience === 'string' && metadata.audience.trim()
        ? metadata.audience.trim()
        : resolvePromotedReportAudience(),
    output_format:
      typeof metadata.output_format === 'string' && metadata.output_format.trim()
        ? metadata.output_format.trim()
        : resolvePromotedReportOutputFormat(),
  };
}

/**
 * Pattern used to mark test-only tracks. Promotion is suppressed for these so
 * that running the test suite (or any TEST-tier mission) does not pollute the
 * committed `knowledge/public/common/.../generated/` directories with
 * fixture-shaped records.
 */
const TEST_TRACK_PATTERN = /^TRK-TEST-/i;

/**
 * Generic fallback titles emitted by buildPromotedMemoryRecord when the source
 * candidate had no real title. A record matching one of these is, by
 * definition, all-fallback content and adds no new knowledge.
 */
const GENERIC_TITLE_PATTERN =
  /^reusable (pattern|sop|sop\s+candidate|hint|knowledge\s+hint|template|report\s+template|memory)$/i;
const MIN_TITLE_LENGTH = 8;
const MIN_SUMMARY_LENGTH = 25;

/**
 * Thrown when a promotion candidate fails the value threshold and would
 * otherwise have produced a generic / fallback record. Callers (e.g. the
 * memory-promotion workflow) should catch this and mark the candidate as
 * `rejected` rather than `promoted`.
 */
export class NotMeaningfulPromotionCandidateError extends Error {
  constructor(
    public readonly reason: string,
    public readonly candidateId: string
  ) {
    super(`Promotion candidate ${candidateId} not meaningful: ${reason}`);
    this.name = 'NotMeaningfulPromotionCandidateError';
  }
}

export interface MeaningfulCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Returns true iff the candidate carries enough non-fallback content to be
 * worth writing as a promoted memory record. Pure function — exported for
 * unit testing.
 */
export function isMeaningfulPromotionCandidate(
  candidate: DistillCandidateRecord
): MeaningfulCheckResult {
  if (candidate.track_id && TEST_TRACK_PATTERN.test(candidate.track_id)) {
    return { ok: false, reason: `test track (${candidate.track_id}) — promotion suppressed` };
  }
  const title = (candidate.title || '').trim();
  if (title.length < MIN_TITLE_LENGTH) {
    return { ok: false, reason: `title too short: "${title || '<empty>'}"` };
  }
  if (GENERIC_TITLE_PATTERN.test(title)) {
    return { ok: false, reason: `title is the generic fallback shape: "${title}"` };
  }
  const summary = (candidate.summary || '').trim();
  if (summary.length < MIN_SUMMARY_LENGTH) {
    return { ok: false, reason: `summary too short (< ${MIN_SUMMARY_LENGTH} chars)` };
  }
  const md = (candidate.metadata || {}) as Record<string, unknown>;
  if (candidate.target_kind === 'pattern') {
    const hasApplicability = normalizeLines(md.applicability).length > 0;
    const hasSteps = normalizeLines(md.reusable_steps).length > 0;
    const hasOutcome =
      typeof md.expected_outcome === 'string' && md.expected_outcome.trim().length > 0;
    if (!hasApplicability && !hasSteps && !hasOutcome) {
      return {
        ok: false,
        reason: 'pattern has no applicability/steps/outcome metadata — would be all fallback',
      };
    }
  } else if (candidate.target_kind === 'sop_candidate') {
    const hasSteps = normalizeLines(md.procedure_steps).length > 0;
    if (!hasSteps) {
      return {
        ok: false,
        reason: 'sop_candidate has no procedure_steps metadata — would be all fallback',
      };
    }
  } else if (candidate.target_kind === 'knowledge_hint') {
    const hasScope = typeof md.hint_scope === 'string' && md.hint_scope.trim().length > 0;
    const hasTriggers = normalizeLines(md.hint_triggers).length > 0;
    if (!hasScope && !hasTriggers) {
      return {
        ok: false,
        reason: 'knowledge_hint has no scope or triggers — would be all fallback',
      };
    }
  } else if (candidate.target_kind === 'report_template') {
    const hasSections = normalizeLines(md.template_sections).length > 0;
    if (!hasSections) {
      return {
        ok: false,
        reason: 'report_template has no template_sections — would be all fallback',
      };
    }
  }
  return { ok: true };
}

export function savePromotedMemoryRecord(
  candidate: DistillCandidateRecord,
  options: { executionRole?: PromotedMemoryExecutionRole } = {}
): { logicalPath: string; record: PromotedMemoryRecord } {
  const meaningful = isMeaningfulPromotionCandidate(candidate);
  if (!meaningful.ok) {
    throw new NotMeaningfulPromotionCandidateError(
      meaningful.reason || 'unknown reason',
      candidate.candidate_id
    );
  }
  const executionRole = options.executionRole || 'mission_controller';
  return withPromotedMemoryExecutionContext(executionRole, () => {
    const record = buildPromotedMemoryRecord(candidate);
    const validate = ensureValidator(record.kind);
    if (!validate(record)) {
      const errors = (validate.errors || []).map(
        (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
      );
      throw new Error(`Invalid promoted memory record: ${errors.join('; ')}`);
    }
    const logicalDir = logicalDirFor({
      kind: record.kind,
      tier: record.tier,
      scope: candidate.scope,
    });
    const absDir = assertSafeRepositoryPath(pathResolver.resolve(logicalDir), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(absDir)) safeMkdir(absDir, { recursive: true });
    const baseName = record.record_id;
    const jsonPath = assertSafeRepositoryPath(path.join(absDir, `${baseName}.json`), {
      allowMissingLeaf: true,
    });
    const mdPath = assertSafeRepositoryPath(path.join(absDir, `${baseName}.md`), {
      allowMissingLeaf: true,
    });
    safeWriteFile(jsonPath, JSON.stringify(record, null, 2));
    const markdown = buildMarkdown(record);
    safeWriteFile(mdPath, markdown);
    backlinkSupersededRecord(record);
    if (record.kind === 'knowledge_hint') {
      appendGovernanceHintRecord(record, candidate.scope);
    }
    return {
      logicalPath: `${logicalDir}/${baseName}.md`,
      record,
    };
  });
}
