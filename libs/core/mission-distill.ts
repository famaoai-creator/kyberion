/**
 * scripts/refactor/mission-distill.ts
 * Knowledge distillation (Wisdom extraction) for completed missions.
 */

import * as path from 'node:path';
import { z } from 'zod';
import { enqueueMemoryPromotionCandidate } from './memory-promotion-queue.js';
import { ledger } from './ledger.js';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import { resolveMissionDistillMarkdownPolicy } from './mission-distill-markdown-policy.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExec,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { transitionStatus } from './mission-status.js';
import { type MissionState } from './mission-types.js';
import { findMissionPath } from './path-resolver.js';
import { loadState, saveState } from './mission-state.js';
import { syncProjectLedgerIfLinked } from './mission-project-ledger.js';
import { runAdaptiveStructuredLlmProfile, type LlmPolicyConfig } from './mission-llm.js';
import { defineCatalog } from './foundation/governed-catalog.js';

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

export function resolveWisdomOutputPath(outputDir: string, wisdomFileName: string): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(path.join(outputDir, wisdomFileName)), {
    allowMissingLeaf: true,
  });
}

const WISDOM_SCHEMA = z.object({
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
    const ledgerContent = safeReadFile(ledgerPath, { encoding: 'utf8' }) as string;
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

export function formatWisdomMarkdown(wisdom: any, missionId: string): string {
  const distillPolicy = resolveMissionDistillMarkdownPolicy();
  const now = new Date().toISOString().slice(0, 10);
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
    '---',
    '',
    `# ${wisdom.title || `Distillation: ${missionId}`}`,
    '',
  ];

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

  lines.push('---', `*Distilled by Kyberion | Mission: ${missionId} | ${now}*`, '');

  return lines.join('\n');
}

export async function distillMission(id: string, rootDir: string): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller distill <MISSION_ID>');
    return;
  }
  const upperId = id.toUpperCase();
  const missionPathCandidate = findMissionPath(upperId);
  if (!missionPathCandidate) throw new Error(`Mission directory for ${upperId} not found.`);
  const missionPath = assertSafeRepositoryPath(missionPathCandidate, { allowMissingLeaf: true });
  const state = loadState(upperId);
  if (!state)
    throw new Error(`Mission ${upperId} not found. Run "list" to see available missions.`);

  if (state.status !== 'distilling' && state.status !== 'validating') {
    const hint =
      state.status === 'active'
        ? 'Run "verify" first to move the mission to distilling status.'
        : state.status === 'completed'
          ? 'This mission is already completed.'
          : `Current status "${state.status}" cannot transition to distillation.`;
    logger.error(`❌ Cannot distill mission ${upperId} (status: ${state.status}). ${hint}`);
    return;
  }

  logger.info(`🧠 Distilling Wisdom for Mission ${upperId}...`);

  const context = gatherDistillContext(upperId, state, missionPath);

  const promptTemplatePath = pathResolver.knowledge('product/governance/distill-prompt.md');
  const promptTemplate = safeExistsSync(promptTemplatePath)
    ? (safeReadFile(promptTemplatePath, { encoding: 'utf8' }) as string)
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
  try {
    const llmPolicy: LlmPolicyConfig | undefined = wisdomPolicy?.llm;
    wisdom = await runAdaptiveStructuredLlmProfile('distill', fullPrompt, WISDOM_SCHEMA, {
      policy: llmPolicy,
      systemPrompt:
        "You are Kyberion's Wisdom Distiller. Return exactly one JSON object matching the schema.",
    });
    llmUsed = true;
  } catch (err: any) {
    logger.warn(`⚠️ LLM distillation failed: ${err.message}`);
    logger.info('Falling back to structural distillation (no LLM)...');
    wisdom = buildFallbackWisdom(upperId, state);
  }

  const defaultOutputDir = 'knowledge/product/evolution';
  const mappedOutputDir = wisdomPolicy?.tier_mapping?.[state.tier] || defaultOutputDir;
  const outputDir = /(^|\/)incidents(\/|$)/.test(mappedOutputDir)
    ? defaultOutputDir
    : mappedOutputDir;
  if (outputDir !== mappedOutputDir) {
    logger.warn(
      `⚠️ wisdom-policy output_dir "${mappedOutputDir}" was normalized to "${outputDir}" for writable public distillation output.`
    );
  }

  const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
  const wisdomFileName = `distill_${upperId.toLowerCase()}_${dateSlug}.md`;
  const wisdomFilePath = resolveWisdomOutputPath(outputDir, wisdomFileName);
  const wisdomDirPath = path.dirname(wisdomFilePath);

  if (!safeExistsSync(wisdomDirPath)) safeMkdir(wisdomDirPath, { recursive: true });

  const wisdomMd = formatWisdomMarkdown(wisdom, upperId);
  safeWriteFile(wisdomFilePath, wisdomMd);
  logger.info(`📝 Wisdom written to ${path.relative(rootDir, wisdomFilePath)}`);

  const completedAt = new Date().toISOString();
  state.status = transitionStatus(state.status, 'completed');
  state.completed_at = completedAt;
  state.distillation = {
    status: 'completed',
    completed_at: completedAt,
    mode: llmUsed ? 'llm' : 'structural',
    llm_used: llmUsed,
    output_path: wisdomFilePath,
  };
  state.context = {
    ...(state.context || {}),
    distill_output_path: wisdomFilePath,
    distill_output_dir: outputDir,
  } as any;
  state.history.push({
    ts: new Date().toISOString(),
    event: 'DISTILL',
    note: `Knowledge distillation completed. Output: ${wisdomFileName}`,
  });

  await saveState(upperId, state);
  await syncProjectLedgerIfLinked(upperId, rootDir);

  // Auto-enqueue the distilled wisdom into the memory-promotion queue so the
  // mission-closure path of the corporate-memory loop (execute → distill →
  // promote) advances without manual operator glue. Higher tiers require human
  // ratification before promotion.
  try {
    const tier: 'public' | 'confidential' | 'personal' =
      state.tier === 'confidential'
        ? 'confidential'
        : state.tier === 'personal'
          ? 'personal'
          : 'public';
    enqueueMemoryPromotionCandidate({
      candidate_id: `mem-${upperId}-${dateSlug}`,
      source_type: 'mission',
      source_ref: upperId,
      proposed_memory_kind: 'heuristic',
      summary: `Distilled wisdom from mission ${upperId}`,
      evidence_refs: [path.join(outputDir, wisdomFileName)],
      sensitivity_tier: tier,
      ratification_required: tier !== 'public',
      status: 'queued',
      queued_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn(
      `⚠️ Failed to enqueue memory promotion candidate for ${upperId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  ledger.record('MISSION_DISTILL', {
    mission_id: upperId,
    wisdom_file: wisdomFileName,
    output_dir: outputDir,
    llm_used: llmUsed,
    distillation_mode: llmUsed ? 'llm' : 'structural',
  });

  logger.success(`✅ Wisdom distilled for ${upperId}. Mission ready for finishing.`);
}
