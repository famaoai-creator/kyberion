import * as crypto from 'node:crypto';
import { slugify } from '../foundation/text.js';
import type {
  MissionContextPack,
  MissionContextRecipientKind,
  MissionTier,
} from './mission-context-pack-types.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir } from '../secure-io.js';
import { provisionMissionEntry, writeProvisionedText } from './mission-orchestration-journal.js';
import * as path from 'node:path';

export function summarizeText(value: unknown, max = 180): string | undefined {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function estimatedChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value || '').length;
  }
}

export function truncateText(value: string | undefined, max: number): string | undefined {
  if (!value) return value;
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

export function clonePack(pack: MissionContextPack): MissionContextPack {
  return JSON.parse(JSON.stringify(pack)) as MissionContextPack;
}

export function buildRollupSummary(pack: MissionContextPack, prunedSections: string[]): string {
  const lines = [
    `Mission context rollup for ${pack.scope.mission_id}`,
    `- Pack ID: ${pack.context_pack_id}`,
    `- Recipient: ${pack.recipient.kind}${pack.recipient.team_role ? ` / role=${pack.recipient.team_role}` : ''}`,
    `- Scope: tier=${pack.scope.tier}${pack.scope.tenant_slug ? `; tenant=${pack.scope.tenant_slug}` : ''}${pack.scope.organization_id ? `; organization=${pack.scope.organization_id}` : ''}${pack.scope.project_id ? `; project=${pack.scope.project_id}` : ''}${pack.scope.track_id ? `; track=${pack.scope.track_id}` : ''}${pack.scope.work_item_id ? `; work_item=${pack.scope.work_item_id}` : ''}`,
    `- Pruned sections: ${prunedSections.length > 0 ? prunedSections.join(', ') : 'none'}`,
  ];
  if (pack.project?.summary)
    lines.push(
      `- Project summary: ${summarizeText(pack.project.summary, 220) || pack.project.summary}`
    );
  if (pack.track?.summary)
    lines.push(`- Track summary: ${summarizeText(pack.track.summary, 220) || pack.track.summary}`);
  if (pack.task_session?.goal?.summary)
    lines.push(
      `- Task goal: ${summarizeText(pack.task_session.goal.summary, 180) || pack.task_session.goal.summary}`
    );
  if (pack.work_item?.title) lines.push(`- Work item: ${pack.work_item.title}`);
  return lines.join('\n');
}

export function pruneMissionContextPack(
  pack: MissionContextPack,
  budgetChars?: number,
  missionPath?: string
): MissionContextPack {
  const budget = typeof budgetChars === 'number' && budgetChars > 0 ? budgetChars : 6000;
  const working = clonePack(pack);
  const originalEstimate = estimatedChars(working);
  const prunedSections: string[] = [];
  const keptSections = ['scope', 'recipient', 'mission', 'sources', 'redactions', 'delivery'];

  if (originalEstimate <= budget) {
    const rollupSummary = buildRollupSummary(working, []);
    const rollupPath = writeMissionContextRollup(missionPath, working, rollupSummary);
    return {
      ...working,
      pruning: {
        budget_chars: budget,
        estimated_chars: originalEstimate,
        kept_sections: keptSections,
        pruned_sections: [],
        rollup_summary: rollupSummary,
        ...(rollupPath ? { rollup_path: rollupPath } : {}),
      },
    };
  }

  if (working.knowledge_hints && working.knowledge_hints.length > 3) {
    working.knowledge_hints = working.knowledge_hints.slice(0, 3);
    prunedSections.push('knowledge_hints');
  }
  if (working.artifact_hints && working.artifact_hints.length > 2) {
    working.artifact_hints = working.artifact_hints.slice(0, 2);
    if (!prunedSections.includes('artifact_hints')) prunedSections.push('artifact_hints');
  }

  working.project = working.project
    ? {
        ...working.project,
        summary: truncateText(working.project.summary, 260) || working.project.summary,
        knowledge_refs: working.project.knowledge_refs?.slice(0, 3),
        distill_targets: working.project.distill_targets?.slice(0, 3),
      }
    : working.project;

  working.track = working.track
    ? {
        ...working.track,
        summary: truncateText(working.track.summary, 220) || working.track.summary,
        required_artifacts: working.track.required_artifacts?.slice(0, 3),
      }
    : working.track;

  working.task_session = working.task_session
    ? {
        ...working.task_session,
        goal: {
          ...working.task_session.goal,
          summary:
            truncateText(working.task_session.goal.summary, 180) ||
            working.task_session.goal.summary,
        },
      }
    : working.task_session;

  working.work_item = working.work_item
    ? {
        ...working.work_item,
        description:
          truncateText(working.work_item.description, 220) || working.work_item.description,
        labels: working.work_item.labels.slice(0, 8),
        dependencies: working.work_item.dependencies.slice(0, 5),
      }
    : working.work_item;

  const prunedEstimate = estimatedChars(working);
  if (prunedEstimate > budget) {
    working.knowledge_hints = working.knowledge_hints?.slice(0, 1);
    working.artifact_hints = working.artifact_hints?.slice(0, 1);
    if (!prunedSections.includes('knowledge_hints')) prunedSections.push('knowledge_hints');
    if (!prunedSections.includes('artifact_hints')) prunedSections.push('artifact_hints');
  }

  const finalEstimate = estimatedChars(working);
  const rollupSummary = buildRollupSummary(working, prunedSections);
  const rollupPath = writeMissionContextRollup(missionPath, working, rollupSummary);

  return {
    ...working,
    pruning: {
      budget_chars: budget,
      estimated_chars: finalEstimate,
      kept_sections: keptSections,
      pruned_sections: prunedSections,
      rollup_summary: rollupSummary,
      ...(rollupPath ? { rollup_path: rollupPath } : {}),
    },
  };
}

export function safeMissionPath(missionPath: string): string {
  return assertSafeRepositoryPath(missionPath, { allowMissingLeaf: true });
}

export function safeMissionArtifactPath(missionPath: string, relativePath: string): string {
  const safeRoot = safeMissionPath(missionPath);
  return assertSafeRepositoryPath(path.join(safeRoot, relativePath), {
    allowMissingLeaf: true,
  });
}

export function writeMissionContextRollup(
  missionPath: string | undefined,
  pack: MissionContextPack,
  rollupSummary: string
): string | undefined {
  if (!missionPath) return undefined;
  const targetDir = safeMissionArtifactPath(missionPath, 'coordination/context-rollups');
  if (!safeExistsSync(targetDir)) safeMkdir(targetDir, { recursive: true });
  const filePath = safeMissionArtifactPath(
    missionPath,
    `coordination/context-rollups/${pack.context_pack_id}.md`
  );
  writeProvisionedText({
    missionId: pack.scope.mission_id,
    filePath,
    targetPath: path.relative(missionPath, filePath).split(path.sep).join('/'),
    missionPathHint: missionPath,
    provisioned: provisionMissionEntry(`${rollupSummary}\n`),
  });
  return filePath;
}

export function normalizeTier(tier: unknown, fallback: MissionTier = 'public'): MissionTier {
  return tier === 'personal' || tier === 'confidential' || tier === 'public' ? tier : fallback;
}

export function buildContextPackId(input: {
  missionId: string;
  teamRole?: string;
  recipientKind?: MissionContextRecipientKind;
  workItemId?: string;
}): string {
  const parts = [
    'CPK',
    slugify(input.missionId.toUpperCase(), { separator: '-', fallback: 'MISSION' }).toUpperCase(),
  ];
  if (input.teamRole) {
    parts.push(slugify(input.teamRole, { separator: '-', fallback: 'role' }).toUpperCase());
  } else if (input.recipientKind) {
    parts.push(
      slugify(input.recipientKind, { separator: '-', fallback: 'recipient' }).toUpperCase()
    );
  }
  if (input.workItemId) {
    parts.push(slugify(input.workItemId, { separator: '-', fallback: 'item' }).toUpperCase());
  }
  parts.push(crypto.randomUUID().slice(0, 8).toUpperCase());
  return parts.join('-');
}

/**
 * Existing mission directory from its own record (all tiers/tenants). The
 * caller tier is only a fallback for a descriptive source ref of a mission
 * that is not on disk — context-pack paths are read, never written, here.
 */
