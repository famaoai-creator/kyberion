/**
 * scripts/refactor/mission-distill.ts
 * Knowledge distillation (Wisdom extraction) for completed missions.
 */

import * as path from 'node:path';
import { z } from 'zod';
import {
  ledger,
  logger,
  pathResolver,
  safeExistsSync,
  safeExec,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  transitionStatus,
} from '@agent/core';
import { type MissionState } from './mission-types.js';
import { findMissionPath } from '@agent/core';
import { loadState, saveState } from './mission-state.js';
import { syncProjectLedgerIfLinked } from './mission-project-ledger.js';
import { readJsonFile } from './cli-input.js';
import {
  inspectLlmResolution,
  resolveLlmConfig,
  runStructuredLlmProfile,
  type LlmPolicyConfig,
} from './mission-llm.js';

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

const WISDOM_POLICY_SCHEMA = z.object({
  version: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  llm: z
    .object({
      profiles: z.record(
        z.string(),
        z.object({
          description: z.string().optional(),
          command: z.string(),
          args: z.array(z.string()),
          timeout_ms: z.number().optional(),
          response_format: z.string().optional(),
          adapter: z.string().optional(),
        }),
      ).optional(),
      purpose_map: z.record(z.string(), z.string()).optional(),
      default_profile: z.string().optional(),
    })
    .optional(),
  rules: z.array(z.unknown()).optional(),
  tier_mapping: z.record(z.string(), z.string()).optional(),
});

export function gatherDistillContext(missionId: string, state: MissionState, missionPath: string): string {
  const parts: string[] = [];

  try {
    const gitLog = safeExec('git', ['log', '--oneline', '-20'], { cwd: missionPath });
    parts.push('### Git History (last 20 commits)');
    parts.push(gitLog.trim());
  } catch (_) {
    parts.push('### Git History: unavailable');
  }

  const ledgerPath = path.join(missionPath, 'evidence', 'ledger.jsonl');
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
  const failureEvents = state.history.filter(
    h => h.event === 'FAIL' || h.event === 'VERIFY' || h.note.includes('failed') || h.note.includes('Error')
  );
  const hasFailures = failureEvents.length > 0;
  const lastError = failureEvents.length > 0 ? failureEvents[failureEvents.length - 1].note : 'None';

  return {
    title: `Mission ${missionId} Completion Summary`,
    category: hasFailures ? 'Incident' : 'Operations',
    tags: [state.tier, state.assigned_persona.toLowerCase().replace(/\s+/g, '-'), 'auto-distilled'],
    importance: hasFailures ? 5 : 3,
    sections: {
      summary: `Mission ${missionId} completed with ${state.git.checkpoints.length} checkpoints and ${state.history.length} lifecycle events.`,
      key_learnings: [
        '(Automatic distillation — manual review recommended)',
        hasFailures ? `Last detected friction: ${lastError}` : 'No significant friction detected.'
      ],
      patterns_discovered: ['None extracted automatically (policy fallback)'],
      failures_and_recoveries: hasFailures
        ? failureEvents.map(e => `${e.ts}: ${e.note}`)
        : ['None'],
      reusable_artifacts: ['None identified'],
    },
  };
}

export function formatWisdomMarkdown(wisdom: any, missionId: string): string {
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
    lines.push('## Summary', sections.summary, '');
  }

  if (sections.key_learnings?.length) {
    lines.push('## Key Learnings');
    for (const l of sections.key_learnings) lines.push(`- ${l}`);
    lines.push('');
  }

  if (sections.patterns_discovered?.length) {
    lines.push('## Patterns Discovered');
    for (const p of sections.patterns_discovered) lines.push(`- ${p}`);
    lines.push('');
  }

  if (sections.failures_and_recoveries?.length && sections.failures_and_recoveries[0] !== 'None') {
    lines.push('## Failures & Recoveries');
    for (const f of sections.failures_and_recoveries) lines.push(`- ${f}`);
    lines.push('');
  }

  if (sections.reusable_artifacts?.length && sections.reusable_artifacts[0] !== 'None identified') {
    lines.push('## Reusable Artifacts');
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
  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} not found. Run "list" to see available missions.`);

  if (state.status !== 'distilling' && state.status !== 'validating') {
    const hint = state.status === 'active'
      ? 'Run "verify" first to move the mission to distilling status.'
      : state.status === 'completed'
        ? 'This mission is already completed.'
        : `Current status "${state.status}" cannot transition to distillation.`;
    logger.error(`❌ Cannot distill mission ${upperId} (status: ${state.status}). ${hint}`);
    return;
  }

  const missionPath = findMissionPath(upperId);
  if (!missionPath) throw new Error(`Mission directory for ${upperId} not found.`);

  logger.info(`🧠 Distilling Wisdom for Mission ${upperId}...`);

  const context = gatherDistillContext(upperId, state, missionPath);

  const promptTemplatePath = pathResolver.knowledge('public/governance/distill-prompt.md');
  const promptTemplate = safeExistsSync(promptTemplatePath)
    ? safeReadFile(promptTemplatePath, { encoding: 'utf8' }) as string
    : '';

  const fullPrompt = [
    promptTemplate,
    '',
    '---',
    '## Mission State',
    '```json',
    JSON.stringify(state, null, 2),
    '```',
    '',
    '## Evidence & Context',
    '```',
    context,
    '```',
  ].join('\n');

  const wisdomPolicyPath = pathResolver.knowledge('public/governance/wisdom-policy.json');
  let wisdomPolicy: any = {};
  if (safeExistsSync(wisdomPolicyPath)) {
    try {
      const parsed = readJsonFile<any>(wisdomPolicyPath);
      const validated = WISDOM_POLICY_SCHEMA.safeParse(parsed);
      if (validated.success) {
        wisdomPolicy = validated.data;
      } else {
        logger.warn(`⚠️ wisdom-policy.json failed validation: ${validated.error.message}`);
      }
    } catch (err: any) {
      logger.warn(`⚠️ Failed to load wisdom-policy.json: ${err.message}`);
    }
  }

  let wisdom: any = null;
  try {
    const llmPolicy: LlmPolicyConfig | undefined = wisdomPolicy.llm;
    const llmStatus = inspectLlmResolution('distill', llmPolicy);
    logger.info(
      `🤖 Distill LLM check: profile=${llmStatus.selectedProfile ?? 'none'} command=${llmStatus.selectedCommand ?? 'none'}`,
    );
    const resolvedProfile = resolveLlmConfig('distill', llmPolicy);
    wisdom = await runStructuredLlmProfile(
      resolvedProfile,
      fullPrompt,
      WISDOM_SCHEMA,
      { systemPrompt: 'You are Kyberion\'s Wisdom Distiller. Return exactly one JSON object matching the schema.' },
    );
  } catch (err: any) {
    logger.warn(`⚠️ LLM distillation failed: ${err.message}`);
    logger.info('Falling back to structural distillation (no LLM)...');
    wisdom = buildFallbackWisdom(upperId, state);
  }

  let outputDir = 'knowledge/public/evolution';
  outputDir = wisdomPolicy.tier_mapping?.[state.tier] || outputDir;

  const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
  const wisdomFileName = `distill_${upperId.toLowerCase()}_${dateSlug}.md`;
  const wisdomFilePath = pathResolver.rootResolve(path.join(outputDir, wisdomFileName));
  const wisdomDirPath = path.dirname(wisdomFilePath);

  if (!safeExistsSync(wisdomDirPath)) safeMkdir(wisdomDirPath, { recursive: true });

  const wisdomMd = formatWisdomMarkdown(wisdom, upperId);
  safeWriteFile(wisdomFilePath, wisdomMd);
  logger.info(`📝 Wisdom written to ${path.relative(rootDir, wisdomFilePath)}`);

  state.status = transitionStatus(state.status, 'completed');
  state.history.push({
    ts: new Date().toISOString(),
    event: 'DISTILL',
    note: `Knowledge distillation completed. Output: ${wisdomFileName}`,
  });

  await saveState(upperId, state);
  await syncProjectLedgerIfLinked(upperId, rootDir);

  ledger.record('MISSION_DISTILL', {
    mission_id: upperId,
    wisdom_file: wisdomFileName,
    output_dir: outputDir,
    llm_used: wisdom !== null,
  });

  logger.success(`✅ Wisdom distilled for ${upperId}. Mission ready for finishing.`);
}
