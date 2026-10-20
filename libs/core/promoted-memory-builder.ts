/** Record construction and rendering, independent of publisher and approval orchestration. */
import type { DistillCandidateRecord } from './knowledge/distill-candidate-registry.js';
import type { OrganizationWorkLoopSummary } from './workforce/work-design.js';
import type { MemoryScopeEnvelope } from './knowledge/memory-scope.js';
import { assertScopedLearningScope } from './knowledge/scoped-learning-domain.js';
import { nowIso } from './foundation/time.js';
import {
  resolvePromotedReportAudience,
  resolvePromotedReportOutputFormat,
  resolvePromotedReportTemplateSections,
} from './promoted-report-template-policy.js';

interface PromotedMemoryRecordBase {
  scope?: MemoryScopeEnvelope;
  approved_payload_digest?: string;
  record_id: string;
  kind: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';
  tier: 'personal' | 'confidential' | 'public';
  knowledge_domain: 'product' | 'organization' | 'personal';
  owner_nhi?: string;
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
  /** KL-05: branch of the checkout the record was written into (omitted when git is unavailable). */
  source_branch?: string;
  /** KL-05: HEAD commit of that checkout at promotion time. */
  source_commit?: string;
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

export function normalizePromotedMemoryLines(value: unknown): string[] {
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

function yamlOptionalString(value: string | undefined): string {
  return value?.trim() ? value : '""';
}

export function buildPromotedMemoryMarkdown(record: PromotedMemoryRecord): string {
  const frontmatter = [
    `---`,
    `record_id: ${record.record_id}`,
    `kind: ${record.kind}`,
    `tier: ${record.tier}`,
    `knowledge_domain: ${record.knowledge_domain}`,
    `owner_nhi: ${yamlOptionalString(record.owner_nhi)}`,
    `candidate_id: ${record.candidate_id}`,
    ...(record.scope ? [`scope: ${JSON.stringify(record.scope)}`] : []),
    ...(record.approved_payload_digest
      ? [`approved_payload_digest: ${record.approved_payload_digest}`]
      : []),
    `supersedes: ${yamlOptionalString(record.supersedes)}`,
    `superseded_by: ${yamlOptionalString(record.superseded_by)}`,
    `project_id: ${yamlOptionalString(record.project_id)}`,
    `task_session_id: ${yamlOptionalString(record.task_session_id)}`,
    `specialist_id: ${yamlOptionalString(record.specialist_id)}`,
    `locale: ${yamlOptionalString(record.locale)}`,
    `created_at: ${record.created_at}`,
    ...(record.source_branch ? [`source_branch: ${record.source_branch}`] : []),
    ...(record.source_commit ? [`source_commit: ${record.source_commit}`] : []),
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
    ...(candidate.scope && typeof metadata.approved_payload_digest === 'string'
      ? {
          scope: assertScopedLearningScope(candidate.scope),
          approved_payload_digest: metadata.approved_payload_digest,
        }
      : {}),
    kind: candidate.target_kind,
    tier,
    knowledge_domain:
      metadata.knowledge_domain === 'product' || metadata.knowledge_domain === 'personal'
        ? metadata.knowledge_domain
        : 'organization',
    ...(typeof metadata.personal_owner_nhi === 'string'
      ? { owner_nhi: metadata.personal_owner_nhi }
      : {}),
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
        normalizePromotedMemoryLines(metadata.applicability).length > 0
          ? normalizePromotedMemoryLines(metadata.applicability)
          : ['repeatable delivery work', candidate.specialist_id || 'general specialist'],
      reusable_steps:
        normalizePromotedMemoryLines(metadata.reusable_steps).length > 0
          ? normalizePromotedMemoryLines(metadata.reusable_steps)
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
        normalizePromotedMemoryLines(metadata.procedure_steps).length > 0
          ? normalizePromotedMemoryLines(metadata.procedure_steps)
          : fallbackSteps(candidate.summary, [
              'inspect the current state',
              'apply the standard operator action',
              'confirm the outcome and capture evidence',
            ]),
      safety_notes:
        normalizePromotedMemoryLines(metadata.safety_notes).length > 0
          ? normalizePromotedMemoryLines(metadata.safety_notes)
          : [
              'Require approval before irreversible or high-risk actions.',
              'Capture evidence before and after the action.',
            ],
      escalation_conditions:
        normalizePromotedMemoryLines(metadata.escalation_conditions).length > 0
          ? normalizePromotedMemoryLines(metadata.escalation_conditions)
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
        normalizePromotedMemoryLines(metadata.hint_triggers).length > 0
          ? normalizePromotedMemoryLines(metadata.hint_triggers)
          : [candidate.title, candidate.summary].filter(Boolean),
      recommended_refs:
        normalizePromotedMemoryLines(metadata.recommended_refs).length > 0
          ? normalizePromotedMemoryLines(metadata.recommended_refs)
          : candidate.evidence_refs || [],
    };
  }
  return {
    ...base,
    kind: 'report_template',
    template_sections:
      normalizePromotedMemoryLines(metadata.template_sections).length > 0
        ? normalizePromotedMemoryLines(metadata.template_sections)
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
