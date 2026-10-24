import { renderSkillResourceIndex } from '../plugin/skill-resource-loader.js';
import { formatKnowledgeVerificationLabel } from '../knowledge/knowledge-verification.js';
import type { MissionContextPack } from './mission-context-pack-types.js';

export function summarizeText(value: unknown, max = 180): string | undefined {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function renderMissionContextPack(pack: MissionContextPack): string {
  const lines: string[] = [
    'Mission context pack (scoped, minimal, role-specific).',
    `- Pack ID: ${pack.context_pack_id}`,
    `- Scope: mission=${pack.scope.mission_id}; tier=${pack.scope.tier}${pack.scope.tenant_slug ? `; tenant=${pack.scope.tenant_slug}` : ''}${pack.scope.organization_id ? `; organization=${pack.scope.organization_id}` : ''}${pack.scope.project_id ? `; project=${pack.scope.project_id}` : ''}${pack.scope.task_session_id ? `; task_session=${pack.scope.task_session_id}` : ''}${pack.scope.work_item_id ? `; work_item=${pack.scope.work_item_id}` : ''}`,
    `- Recipient: ${pack.recipient.kind}${pack.recipient.team_role ? ` / role=${pack.recipient.team_role}` : ''}${pack.recipient.agent_id ? ` / agent=${pack.recipient.agent_id}` : ''}${pack.recipient.authority_role ? ` / authority=${pack.recipient.authority_role}` : ''}`,
    `- Mission: ${pack.mission.mission_id} | ${pack.mission.status}${pack.mission.mission_type ? ` | type=${pack.mission.mission_type}` : ''}${pack.mission.assigned_persona ? ` | persona=${pack.mission.assigned_persona}` : ''}`,
  ];

  if (pack.organization_intent) {
    const intent = pack.organization_intent;
    lines.push(
      `- Organization intent: ${intent.organization_id}${intent.name ? ` | ${intent.name}` : ''} | ${intent.approval_state}`,
      `  - Purpose: ${summarizeText(intent.purpose, 320) || intent.purpose}`
    );
    for (const objective of intent.objectives || []) {
      lines.push(
        `  - Objective: ${objective.objective_id} | ${objective.title}${objective.status ? ` | ${objective.status}` : ''}`
      );
      for (const kr of objective.key_results || []) {
        lines.push(
          `    - KR ${kr.kr_id}: ${kr.title} -> ${kr.direction} ${kr.target}${kr.unit ? ` ${kr.unit}` : ''}`
        );
      }
    }
  }

  if (pack.project) {
    lines.push(
      `- Project: ${pack.project.project_id} | ${pack.project.name} | ${pack.project.status}${pack.project.current_phase ? ` | phase=${pack.project.current_phase}` : ''}`,
      `  - Summary: ${summarizeText(pack.project.summary, 320) || pack.project.summary}`
    );
  }

  if (pack.track) {
    lines.push(
      `- Track: ${pack.track.track_id} | ${pack.track.name} | ${pack.track.status} | ${pack.track.track_type}/${pack.track.lifecycle_model}`,
      `  - Summary: ${summarizeText(pack.track.summary, 280) || pack.track.summary}`
    );
  }

  if (pack.task_session) {
    lines.push(
      `- Task session: ${pack.task_session.session_id} | ${pack.task_session.task_type} | ${pack.task_session.status} | ${pack.task_session.mode}`,
      `  - Goal: ${summarizeText(pack.task_session.goal.summary, 240) || pack.task_session.goal.summary}`
    );
  }

  if (pack.work_item) {
    lines.push(
      `- Work item: ${pack.work_item.item_id} | ${pack.work_item.status} | ${pack.work_item.title}`,
      `  - Description: ${summarizeText(pack.work_item.description, 280) || pack.work_item.description}`
    );
  }

  if (pack.task_guidance) {
    lines.push(
      `- Fast-lane guidance: model_tier=${pack.task_guidance.model_tier}`,
      `  - Acceptance criteria:`,
      ...pack.task_guidance.acceptance_criteria.map((criterion) => `    - ${criterion}`),
      `  - Output contract: ${pack.task_guidance.output_contract}`,
      `  - Verification:`,
      ...pack.task_guidance.verification.map((step) => `    - ${step}`),
      ...(pack.task_guidance.seed?.length
        ? [`  - Seed:`, ...pack.task_guidance.seed.map((entry) => `    - ${entry}`)]
        : [])
    );
  }

  if (pack.facets) {
    if (pack.facets.persona) {
      lines.push(
        `- Persona facet: ${pack.facets.persona.name} (${pack.facets.persona.source})`,
        `  - ${pack.facets.persona.content}`
      );
    }
    for (const facet of [...pack.facets.policies, ...pack.facets.instructions]) {
      lines.push(`- ${facet.name} facet: ${facet.source}`, `  - ${facet.content}`);
    }
    if (pack.facets.output_contract) {
      lines.push(
        `- Output contract facet: ${pack.facets.output_contract.name}`,
        `  - ${pack.facets.output_contract.content}`
      );
    }
  }

  if (pack.skill_resources && pack.skill_resources.length > 0) {
    lines.push(
      '- Available skills (metadata only):',
      renderSkillResourceIndex(pack.skill_resources)
    );
  }

  if (pack.pruning) {
    lines.push(
      `- Context pruning: budget=${pack.pruning.budget_chars}; estimated=${pack.pruning.estimated_chars}`,
      `  - Kept: ${pack.pruning.kept_sections.join(', ')}`,
      `  - Pruned: ${pack.pruning.pruned_sections.length > 0 ? pack.pruning.pruned_sections.join(', ') : 'none'}`,
      ...(pack.pruning.rollup_path ? [`  - Rollup: ${pack.pruning.rollup_path}`] : [])
    );
  }

  if (pack.scope_audit) {
    const counts = new Map<string, number>();
    for (const rejection of pack.scope_audit.rejected) {
      counts.set(rejection.code, (counts.get(rejection.code) || 0) + 1);
    }
    const summary = [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => `${code}=${count}`)
      .join(', ');
    lines.push(
      `- Scope-rejected knowledge: ${pack.scope_audit.rejected.length}${summary ? ` (${summary})` : ''}`
    );
  }

  if (pack.knowledge_hints && pack.knowledge_hints.length > 0) {
    lines.push('- Knowledge hints:');
    for (const hint of pack.knowledge_hints) {
      lines.push(
        `  - ${hint.title} (${hint.path})${formatKnowledgeVerificationLabel(hint.verification)}`
      );
      lines.push(`    ${summarizeText(hint.excerpt, 220) || hint.excerpt}`);
    }
  }

  if (pack.artifact_hints && pack.artifact_hints.length > 0) {
    lines.push('- Reusable artifact hints:');
    for (const hint of pack.artifact_hints) {
      lines.push(`  - ${hint.artifact_id} | ${hint.kind} | ${hint.storage_class}`);
      lines.push(`    ${hint.reuse_reason}`);
      if (hint.path) lines.push(`    path: ${hint.path}`);
      if (hint.project_id || hint.mission_id || hint.task_session_id) {
        lines.push(
          `    lineage: ${[hint.project_id ? `project=${hint.project_id}` : '', hint.mission_id ? `mission=${hint.mission_id}` : '', hint.task_session_id ? `task_session=${hint.task_session_id}` : ''].filter(Boolean).join(', ')}`
        );
      }
    }
  }

  lines.push('- Sources:');
  for (const source of pack.sources) {
    const descriptor = [
      `[${source.kind}] ${source.ref}`,
      source.path ? `(${source.path})` : '',
      source.summary ? `- ${summarizeText(source.summary, 200) || source.summary}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`  - ${descriptor}`);
  }

  lines.push(`- Redactions: ${pack.redactions.length > 0 ? pack.redactions.join('; ') : 'none'}`);
  lines.push(
    '',
    'Use only the facts in this pack and the task instructions that follow. If a necessary fact is missing, report the gap instead of assuming the full knowledge base.'
  );
  return lines.join('\n');
}
