/**
 * libs/core/mission/mission-distill.ts
 * Knowledge distillation (Wisdom extraction) for completed missions.
 */

import * as path from 'node:path';
import { z } from 'zod';
import {
  enqueueMemoryPromotionCandidate,
  loadMemoryPromotionCandidate,
  validateMemoryPromotionCandidate,
  type MemoryCandidate,
} from '../knowledge/memory-promotion-queue.js';
import { ledger } from '../ledger.js';
import { logger } from '../core.js';
import * as pathResolver from '../path-resolver.js';
import { resolveMissionDistillMarkdownPolicy } from './mission-distill-markdown-policy.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExec,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '../secure-io.js';
import { transitionStatus } from './mission-status.js';
import { type MissionState } from './mission-types.js';
import { findMissionPath } from '../path-resolver.js';
import { loadMissionStateIncludingArchive, loadState, saveState } from './mission-state.js';
import { syncProjectLedgerIfLinked } from './mission-project-ledger.js';
import { runAdaptiveStructuredLlmProfile, type LlmPolicyConfig } from './mission-llm.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { readTextFile } from '../foundation/text.js';
import { nowIso } from '../foundation/time.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { getRegisteredEnvText } from '../foundation/env.js';

export const DISTILL_MEMORY_OUTBOX_FILE = 'memory-promotion-outbox.json';

interface DistillMemoryOutbox {
  version: 1;
  mission_id: string;
  status: 'pending' | 'delivered';
  candidate: MemoryCandidate;
}

/** Replay only the persisted candidate: retrying must not regenerate or approve knowledge. */
function deliverDistillMemoryOutbox(filePath: string, state: MissionState): void {
  const outbox = readJsonIfPresent<DistillMemoryOutbox>(filePath);
  if (!outbox) return; // Completed missions predating the outbox have nothing to replay.
  const candidate = outbox.candidate;
  const tier = state.tier || 'confidential';
  if (
    outbox.version !== 1 ||
    outbox.mission_id !== state.mission_id ||
    !['pending', 'delivered'].includes(outbox.status) ||
    !candidate ||
    !validateMemoryPromotionCandidate(candidate).valid ||
    candidate.source_type !== 'mission' ||
    candidate.source_ref !== `mission:${state.mission_id}` ||
    candidate.status !== 'queued' ||
    candidate.sensitivity_tier !== tier ||
    candidate.ratification_required !== (tier !== 'public') ||
    (candidate.scope && candidate.scope.tier !== tier) ||
    (candidate.scope?.tenant_slug ?? '') !== (state.tenant_slug ?? '') ||
    (candidate.scope && candidate.scope.mission_id !== state.mission_id) ||
    (candidate.scope?.organization_id ?? '') !==
      (state.tenant_slug ? (state.organization_id ?? '') : '')
  )
    throw new Error('[MISSION_DISTILL_OUTBOX] Candidate does not match mission identity or scope');
  if (outbox.status === 'delivered') return;
  const existing = loadMemoryPromotionCandidate(candidate.candidate_id, candidate.scope);
  if (existing) {
    if (
      existing.source_type !== candidate.source_type ||
      existing.source_ref !== candidate.source_ref ||
      existing.sensitivity_tier !== candidate.sensitivity_tier ||
      (existing.scope?.tenant_slug ?? '') !== (candidate.scope?.tenant_slug ?? '') ||
      (existing.scope?.organization_id ?? '') !== (candidate.scope?.organization_id ?? '') ||
      (existing.scope?.mission_id ?? '') !== (candidate.scope?.mission_id ?? '')
    )
      throw new Error('[MISSION_DISTILL_OUTBOX] Existing candidate identity mismatch');
    // An acknowledgement may be lost after enqueue. Preserve curation, approval,
    // rejection and promotion exactly as stored rather than re-enqueueing them.
  } else {
    enqueueMemoryPromotionCandidate(candidate);
  }
  writeJson(filePath, { ...outbox, status: 'delivered' });
}

const WISDOM_POLICY_PATH = pathResolver.knowledge('product/governance/wisdom-policy.json');
const WISDOM_POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/wisdom-policy.schema.json'
);

interface WisdomPolicyFile {
  version: string;
  name: string;
  description?: string;
  llm: LlmPolicyConfig;
  rules: unknown[];
  tier_mapping: Record<string, string>;
}

const wisdomPolicyCatalog = defineCatalog<WisdomPolicyFile>({
  id: 'wisdom-policy',
  path: WISDOM_POLICY_PATH,
  schema: WISDOM_POLICY_SCHEMA_PATH,
});

export function loadWisdomPolicy(): WisdomPolicyFile | null {
  if (!safeExistsSync(WISDOM_POLICY_PATH)) return null;
  try {
    return wisdomPolicyCatalog.load();
  } catch (error: any) {
    logger.warn(`⚠️ Failed to load wisdom-policy.json: ${error.message}`);
    return null;
  }
}

export function isRegularMissionDistillPromptPath(filePath: string): boolean {
  if (!safeExistsSync(filePath)) return false;
  try {
    return safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

function listMissionEvidenceRefs(evidenceDir: string, rootDir: string): string[] {
  const refs: string[] = [];
  const visit = (directory: string): void => {
    let entries: string[];
    try {
      entries = safeReaddir(assertSafeRepositoryPath(directory));
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const candidate = assertSafeRepositoryPath(path.join(directory, entry));
      try {
        const stat = safeLstat(candidate);
        if (stat.isDirectory()) visit(candidate);
        else if (stat.isFile()) refs.push(path.relative(rootDir, candidate).replace(/\\/g, '/'));
      } catch {
        // Ignore symlinks and entries that cannot be safely inspected.
      }
    }
  };
  visit(evidenceDir);
  return refs.sort();
}

export function resolveWisdomOutputPath(outputDir: string, wisdomFileName: string): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(path.join(outputDir, wisdomFileName)), {
    allowMissingLeaf: true,
  });
}

/**
 * Change-attribution verdicts, imported from the harness2 experience contract:
 * `confounded` is preferred — not avoided — whenever several components changed
 * at once or a single observation is all that backs the claimed difference. A
 * lesson resting only on confounded rows is a guess and must be narrowed or
 * declined (experience omitted entirely), never promoted as-is.
 */
export const DISTILL_EDIT_ROW_VERDICTS = [
  'helped',
  'hurt',
  'no_observed_effect',
  'confounded',
] as const;

const DISTILL_EDIT_ROW_SCHEMA = z.object({
  /** The harness/knowledge component the change touched, named as it appears. */
  component: z.string().min(1),
  /** What the change actually did. */
  change: z.string().min(1),
  /** The observed difference in execution, citing where it was seen. */
  observed: z.string().min(1),
  verdict: z.enum(DISTILL_EDIT_ROW_VERDICTS),
});

/**
 * The transferable lesson record. All three evidence fields are required when
 * the object is present — an experience without its evidence basis is a guess
 * and fails validation rather than entering the promotion queue.
 */
const DISTILL_EXPERIENCE_SCHEMA = z.object({
  /** The shape of situation the lesson applies to — the pattern, not this task's facts. */
  cue: z.string().min(1),
  /** The transferable operation, naming the component it concerns. */
  lesson: z.string().min(1),
  /** The edit rows / ledger events the lesson rests on. */
  evidence: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const WISDOM_SCHEMA = z.object({
  title: z.string(),
  category: z.enum(['Evolution', 'Incident', 'Operations']),
  tags: z.array(z.string()),
  importance: z.number(),
  sections: z.object({
    summary: z.string(),
    key_learnings: z.array(z.string()),
    patterns_discovered: z.array(z.string()),
    failures_and_recoveries: z.array(z.string()),
    reusable_artifacts: z.array(z.string()),
  }),
  // Structured-output providers represent an absent optional field as null.
  // Absence is not a malformed lesson: present objects still require evidence.
  experience: DISTILL_EXPERIENCE_SCHEMA.nullish(),
  edit_rows: z.array(DISTILL_EDIT_ROW_SCHEMA).nullish(),
});

export function gatherDistillContext(
  missionId: string,
  state: MissionState,
  missionPath: string
): string {
  const parts: string[] = [];
  const safeMissionPath = assertSafeRepositoryPath(missionPath, { allowMissingLeaf: true });

  try {
    const gitLog = safeExec('git', ['log', '--oneline', '-20'], { cwd: safeMissionPath });
    parts.push('### Git History (last 20 commits)');
    parts.push(gitLog.trim());
  } catch (_) {
    parts.push('### Git History: unavailable');
  }

  const ledgerPath = assertSafeRepositoryPath(
    path.join(safeMissionPath, 'evidence', 'ledger.jsonl'),
    {
      allowMissingLeaf: true,
    }
  );
  if (safeExistsSync(ledgerPath)) {
    if (!safeLstat(ledgerPath).isFile()) {
      throw new Error(
        `[MISSION_DISTILL_RESOURCE] evidence ledger must be a regular file: ${ledgerPath}`
      );
    }
    const ledgerContent = readTextFile(ledgerPath);
    const lines = ledgerContent.trim().split('\n');
    parts.push('');
    parts.push(`### Evidence Ledger (${lines.length} events)`);
    parts.push(lines.slice(-30).join('\n'));
  }

  if (state.git.checkpoints.length > 0) {
    parts.push('');
    parts.push('### Checkpoints');
    for (const cp of state.git.checkpoints) {
      parts.push(`- ${cp.ts}: ${cp.task_id} (${cp.commit_hash.slice(0, 8)})`);
    }
  }

  if (state.history.length > 0) {
    parts.push('');
    parts.push('### Status History');
    for (const h of state.history) {
      parts.push(`- ${h.ts}: [${h.event}] ${h.note}`);
    }
  }

  return parts.join('\n');
}

export function buildFallbackWisdom(missionId: string, state: MissionState): any {
  const distillPolicy = resolveMissionDistillMarkdownPolicy();
  const failureEvents = state.history.filter(
    (h) =>
      h.event === 'FAIL' ||
      h.event === 'VERIFY' ||
      h.note.includes('failed') ||
      h.note.includes('Error')
  );
  const hasFailures = failureEvents.length > 0;
  const lastError =
    failureEvents.length > 0 ? failureEvents[failureEvents.length - 1].note : 'None';

  return {
    title: `Mission ${missionId} ${distillPolicy.title_suffix}`,
    category: hasFailures ? 'Incident' : 'Operations',
    tags: [state.tier, state.assigned_persona.toLowerCase().replace(/\s+/g, '-'), 'auto-distilled'],
    importance: hasFailures ? 5 : 3,
    sections: {
      summary: `Mission ${missionId} completed with ${state.git.checkpoints.length} checkpoints and ${state.history.length} lifecycle events.`,
      key_learnings: [
        '(Automatic distillation — manual review recommended)',
        hasFailures ? `Last detected friction: ${lastError}` : 'No significant friction detected.',
      ],
      patterns_discovered: ['None extracted automatically (policy fallback)'],
      failures_and_recoveries: hasFailures
        ? failureEvents.map((e) => `${e.ts}: ${e.note}`)
        : ['None'],
      reusable_artifacts: ['None identified'],
    },
  };
}

export function formatWisdomMarkdown(
  wisdom: any,
  missionId: string,
  provenance?: Pick<
    NonNullable<MissionState['distillation']>,
    'mode' | 'llm_used' | 'structural_reason'
  >
): string {
  const distillPolicy = resolveMissionDistillMarkdownPolicy();
  const now = nowIso().slice(0, 10);
  const tags = (wisdom.tags || []).map((t: string) => `"${t}"`).join(', ');
  const sections = wisdom.sections || {};

  const lines: string[] = [
    '---',
    `title: "${wisdom.title || `Distillation: ${missionId}`}"`,
    `category: ${wisdom.category || 'Operations'}`,
    `tags: [${tags}]`,
    `importance: ${wisdom.importance || 3}`,
    `source_mission: ${missionId}`,
    `author: Kyberion Wisdom Distiller`,
    `last_updated: ${now}`,
    ...(provenance?.mode
      ? [
          `distillation_mode: ${provenance.mode}`,
          `llm_used: ${provenance.llm_used === true}`,
          ...(provenance.structural_reason
            ? [`structural_reason: ${provenance.structural_reason}`]
            : []),
        ]
      : []),
    '---',
    '',
    `# ${wisdom.title || `Distillation: ${missionId}`}`,
    '',
  ];

  if (provenance?.mode === 'structural') {
    lines.push(
      '> Structural extraction only; no LLM distillation was performed. This is not independent review or approval.',
      ''
    );
  }

  if (sections.summary) {
    lines.push(`## ${distillPolicy.section_titles.summary}`, sections.summary, '');
  }

  if (sections.key_learnings?.length) {
    lines.push(`## ${distillPolicy.section_titles.key_learnings}`);
    for (const l of sections.key_learnings) lines.push(`- ${l}`);
    lines.push('');
  }

  if (sections.patterns_discovered?.length) {
    lines.push(`## ${distillPolicy.section_titles.patterns_discovered}`);
    for (const p of sections.patterns_discovered) lines.push(`- ${p}`);
    lines.push('');
  }

  if (sections.failures_and_recoveries?.length && sections.failures_and_recoveries[0] !== 'None') {
    lines.push(`## ${distillPolicy.section_titles.failures_and_recoveries}`);
    for (const f of sections.failures_and_recoveries) lines.push(`- ${f}`);
    lines.push('');
  }

  if (sections.reusable_artifacts?.length && sections.reusable_artifacts[0] !== 'None identified') {
    lines.push(`## ${distillPolicy.section_titles.reusable_artifacts}`);
    for (const a of sections.reusable_artifacts) lines.push(`- ${a}`);
    lines.push('');
  }

  if (wisdom.edit_rows?.length) {
    lines.push(`## ${distillPolicy.section_titles.change_attribution ?? 'Change Attribution'}`);
    for (const row of wisdom.edit_rows) {
      lines.push(
        `- **${row.component}** (${row.verdict}): ${row.change} — observed: ${row.observed}`
      );
    }
    lines.push('');
  }

  if (wisdom.experience) {
    lines.push(`## ${distillPolicy.section_titles.transferable_lesson ?? 'Transferable Lesson'}`);
    for (const field of ['cue', 'lesson', 'evidence', 'confidence'] as const) {
      if (wisdom.experience[field]) {
        lines.push(`- **${field}**: ${wisdom.experience[field]}`);
      }
    }
    lines.push('');
  }

  lines.push('---', `*Distilled by Kyberion | Mission: ${missionId} | ${now}*`, '');

  return lines.join('\n');
}

export async function distillMission(id: string, rootDir: string): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller distill <MISSION_ID>');
    return;
  }
  const upperId = id.toUpperCase();
  const activeMissionPath = findMissionPath(upperId);
  // The archive state loader applies tenant visibility before any archive
  // evidence is inspected. A directory lookup alone is not authorization.
  const state = activeMissionPath ? loadState(upperId) : loadMissionStateIncludingArchive(upperId);
  if (!state)
    throw new Error(`Mission ${upperId} not found. Run "list" to see available missions.`);
  if (state.mission_id !== upperId)
    throw new Error('[MISSION_DISTILL_OUTBOX] Resolved mission identity mismatch');
  const missionPathCandidate =
    activeMissionPath ||
    (state.status === 'archived' ? pathResolver.findArchivedMissionDir(upperId) : undefined);
  if (!missionPathCandidate) throw new Error(`Mission directory for ${upperId} not found.`);
  const missionPath = assertSafeRepositoryPath(missionPathCandidate, { allowMissingLeaf: true });

  const outboxPath = assertSafeRepositoryPath(
    path.join(missionPath, 'evidence', DISTILL_MEMORY_OUTBOX_FILE),
    { allowMissingLeaf: true }
  );
  if (state.status === 'completed' || state.status === 'archived') {
    deliverDistillMemoryOutbox(outboxPath, state);
    logDistillationOutcome(upperId, state.distillation, true);
    return;
  }

  if (state.status !== 'distilling' && state.status !== 'validating') {
    const hint =
      state.status === 'active'
        ? 'Run "verify" first to move the mission to distilling status.'
        : `Current status "${state.status}" cannot transition to distillation.`;
    logger.error(`❌ Cannot distill mission ${upperId} (status: ${state.status}). ${hint}`);
    return;
  }

  logger.info(`🧠 Distilling Wisdom for Mission ${upperId}...`);

  const context = gatherDistillContext(upperId, state, missionPath);

  const promptTemplatePath = pathResolver.knowledge('product/governance/distill-prompt.md');
  const promptTemplate = isRegularMissionDistillPromptPath(promptTemplatePath)
    ? readTextFile(promptTemplatePath)
    : '';

  const fullPrompt = [
    promptTemplate,
    '',
    '---',
    `## ${resolveMissionDistillMarkdownPolicy().prompt_titles.mission_state}`,
    '```json',
    JSON.stringify(state, null, 2),
    '```',
    '',
    `## ${resolveMissionDistillMarkdownPolicy().prompt_titles.evidence_context}`,
    '```',
    context,
    '```',
  ].join('\n');

  const wisdomPolicy = loadWisdomPolicy();

  let wisdom: any = null;
  let llmUsed = false;
  let structuralReason: 'stub_requested' | 'llm_unavailable' | undefined;
  const stubRequested = getRegisteredEnvText('KYBERION_WISDOM_LLM_PROFILE')?.trim() === 'stub';
  try {
    const llmPolicy: LlmPolicyConfig | undefined = wisdomPolicy?.llm;
    wisdom = await runAdaptiveStructuredLlmProfile('distill', fullPrompt, WISDOM_SCHEMA, {
      policy: llmPolicy,
      // The prompt carries the mission state and evidence: providers must
      // clear the tier egress gate before they see it.
      egress: {
        // A state without a tier is treated as confidential (fail closed).
        dataTier: state.tier || 'confidential',
        ...(state.tenant_slug ? { tenantSlug: state.tenant_slug } : {}),
      },
      systemPrompt:
        "You are Kyberion's Wisdom Distiller. Return exactly one JSON object matching the schema.",
    });
    llmUsed = true;
  } catch {
    structuralReason = stubRequested ? 'stub_requested' : 'llm_unavailable';
    logger.warn(
      `LLM distillation unavailable — ${structuralReason} | next: inspect wisdom profile configuration or review structural evidence | evidence: mission ${upperId}`
    );
    logger.info('Falling back to structural distillation (no LLM)...');
    wisdom = buildFallbackWisdom(upperId, state);
  }

  const dateSlug = nowIso().slice(0, 10).replace(/-/g, '_');
  const wisdomFileName = 'distillation.md';
  const wisdomFilePath = assertSafeRepositoryPath(
    path.join(missionPath, 'evidence', wisdomFileName),
    { allowMissingLeaf: true }
  );
  const wisdomDirPath = path.dirname(wisdomFilePath);

  if (!safeExistsSync(wisdomDirPath)) safeMkdir(wisdomDirPath, { recursive: true });

  const provenance = {
    mode: llmUsed ? ('llm' as const) : ('structural' as const),
    llm_used: llmUsed,
    ...(structuralReason ? { structural_reason: structuralReason } : {}),
  };
  const wisdomMd = formatWisdomMarkdown(wisdom, upperId, provenance);
  safeWriteFile(wisdomFilePath, wisdomMd);
  logger.info(`📝 Wisdom written to ${path.relative(rootDir, wisdomFilePath)}`);

  const completedAt = nowIso();
  state.status = transitionStatus(state.status, 'completed');
  state.completed_at = completedAt;
  state.distillation = {
    status: 'completed',
    completed_at: completedAt,
    ...provenance,
    output_path: wisdomFilePath,
  };
  state.context = {
    ...(state.context || {}),
    distill_output_path: wisdomFilePath,
    distill_output_dir: path.relative(rootDir, wisdomDirPath),
  } as any;
  state.history.push({
    ts: nowIso(),
    event: 'DISTILL',
    note: `Knowledge extraction completed (${provenance.mode}${structuralReason ? `: ${structuralReason}; no LLM distillation` : ''}). Output: ${wisdomFileName}`,
  });

  // Auto-enqueue the distilled wisdom into the memory-promotion queue so the
  // mission-closure path of the corporate-memory loop (execute → distill →
  // promote) advances without manual operator glue. Higher tiers require human
  // ratification before promotion.
  const tier: 'public' | 'confidential' | 'personal' =
    state.tier === 'public' ? 'public' : state.tier === 'personal' ? 'personal' : 'confidential';
  const candidate: MemoryCandidate = {
    candidate_id: `mem-${upperId}-${dateSlug}`,
    source_type: 'mission',
    source_ref: `mission:${upperId}`,
    proposed_memory_kind:
      wisdom.category === 'Incident'
        ? 'risk_rule'
        : wisdom.category === 'Operations'
          ? 'sop'
          : 'heuristic',
    summary: wisdom.sections.summary || `Distilled wisdom from mission ${upperId}`,
    knowledge_domain: 'unclassified',
    // Harness2 experience contract: a distillation that produced no
    // cue/lesson/evidence record is marked declined so the review surface can
    // flag it — the edit rows are still kept on the mission's distillation.
    // Only an actual LLM run can "decline": a structural fallback means the
    // record was never inspected, which is unknown, not declined.
    ...(wisdom.experience ? { distill_experience: wisdom.experience } : {}),
    ...(llmUsed ? { distill_experience_declined: !wisdom.experience } : {}),
    evidence_refs: listMissionEvidenceRefs(wisdomDirPath, rootDir),
    ...(state.tenant_slug
      ? {
          scope: {
            tier,
            tenant_slug: state.tenant_slug,
            mission_id: upperId,
            ...(state.organization_id ? { organization_id: state.organization_id } : {}),
          },
        }
      : {}),
    sensitivity_tier: tier,
    ratification_required: tier !== 'public',
    status: 'queued',
    queued_at: nowIso(),
  };
  // The candidate is durable before completion can make future owners skip this
  // mission. A queue failure or lost acknowledgement leaves a replayable intent.
  writeJson(outboxPath, {
    version: 1,
    mission_id: upperId,
    status: 'pending',
    candidate,
  } satisfies DistillMemoryOutbox);
  await saveState(upperId, state);
  await syncProjectLedgerIfLinked(upperId, rootDir);
  try {
    deliverDistillMemoryOutbox(outboxPath, state);
  } catch (err) {
    logger.warn(
      `memory candidate delivery pending — ${err instanceof Error ? err.message : String(err)} | next: rerun mission distill ${upperId} to replay the saved candidate | evidence: ${outboxPath}`
    );
  }

  ledger.record('MISSION_DISTILL', {
    mission_id: upperId,
    wisdom_file: wisdomFileName,
    output_dir: path.relative(rootDir, wisdomDirPath),
    llm_used: llmUsed,
    distillation_mode: llmUsed ? 'llm' : 'structural',
    ...(structuralReason ? { structural_reason: structuralReason } : {}),
  });

  logDistillationOutcome(upperId, state.distillation);
}

/** Lifecycle completion is distinct from the kind of knowledge extraction and review. */
function logDistillationOutcome(
  missionId: string,
  provenance: MissionState['distillation'],
  replay = false
): void {
  const action = replay ? 'Stored extraction' : 'Knowledge extraction completed';
  if (provenance?.mode === 'structural' && provenance.llm_used === false) {
    logger.warn(
      `${action} for ${missionId}: structural only (${provenance.structural_reason || 'reason unknown'}); no LLM distillation or independent review performed by this step. Inspect the evidence before promotion.`
    );
  } else if (provenance?.mode === 'llm' && provenance.llm_used === true) {
    logger.success(
      `✅ ${action} for ${missionId}: LLM distillation. Independent review and finish gates remain separate.`
    );
  } else {
    logger.warn(
      `${action} for ${missionId}: provenance unknown (legacy or incomplete record). Do not infer LLM distillation or independent review.`
    );
  }
}
