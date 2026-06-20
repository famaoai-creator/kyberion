import { afterEach, describe, expect, it } from 'vitest';

import {
  safeExistsSync,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  appendArtifactOwnershipRecord,
  artifactOwnershipRegistryPath,
  createArtifactOwnershipRecord,
} from './artifact-registry.js';
import {
  buildMissionContextPack,
  renderMissionContextPack,
  saveMissionContextPack,
  type MissionContextPack,
} from './mission-context-pack.js';

const missionId = 'MSN-CONTEXT-PACK-TEST-001';
const missionPath = pathResolver.sharedTmp(`mission-context-pack/${missionId}`);
const artifactRegistryPath = artifactOwnershipRegistryPath();
let originalArtifactRegistryRaw: string | null = null;

if (safeExistsSync(artifactRegistryPath)) {
  originalArtifactRegistryRaw = safeReadFile(artifactRegistryPath, { encoding: 'utf8' }) as string;
}

afterEach(() => {
  safeRmSync(missionPath, { recursive: true, force: true });
  if (originalArtifactRegistryRaw !== null) {
    safeWriteFile(artifactRegistryPath, originalArtifactRegistryRaw);
    return;
  }
  if (safeExistsSync(artifactRegistryPath)) safeRmSync(artifactRegistryPath);
});

function makePack(): MissionContextPack {
  return buildMissionContextPack({
    contextPackId: 'CPK-MSN-CONTEXT-PACK-TEST-001-IMPLEMENTER-ABC12345',
    missionPath,
    missionState: {
      mission_id: missionId,
      mission_type: 'product_development',
      tier: 'public',
      status: 'active',
      assigned_persona: 'worker',
      tenant_slug: 'acme',
      execution_mode: 'delegated',
      priority: 3,
      confidence_score: 1,
      git: {
        branch: 'mission/context-pack-test',
        start_commit: 'start-commit',
        latest_commit: 'latest-commit',
        checkpoints: [
          {
            task_id: 'task-1',
            commit_hash: 'commit-1',
            ts: '2026-06-05T00:00:00.000Z',
          },
        ],
      },
      history: [
        {
          ts: '2026-06-05T00:00:00.000Z',
          event: 'create',
          note: 'Mission created for context pack validation',
        },
      ],
      vision_ref: 'vision://context-pack',
      relationships: {
        project: {
          project_id: 'PRJ-CONTEXT-PACK-001',
          project_path: 'active/projects/public/acme/PRJ-CONTEXT-PACK-001/project-os',
          relationship_type: 'supports',
          affected_artifacts: ['knowledge/product/architecture/mission-context-injection-model.md'],
          gate_impact: 'informational',
          traceability_refs: ['trace:mission:context-pack'],
          note: 'Context pack test project',
        },
        track: {
          track_id: 'TRK-CONTEXT-PACK-001',
          track_name: 'Context Pack Track',
          track_type: 'delivery',
          lifecycle_model: 'sdlc',
          relationship_type: 'belongs_to',
          traceability_refs: ['trace:track:context-pack'],
          note: 'Context pack test track',
        },
      },
      context: {
        last_action: 'record-task',
        next_step: 'dispatch-workitems',
        routing_decision_summary: 'scope minimal context to implementer only',
      },
      outcome_contract: {
        outcome_id: 'outcome-context-pack',
        requested_result: 'Scoped mission context pack',
        deliverable_kind: 'architecture-doc',
        success_criteria: ['pack is role-scoped', 'pack is traceable'],
        evidence_required: true,
      },
    },
    teamRole: 'implementer',
    recipientKind: 'agent',
    assigneePeerId: 'implementation-architect',
    projectState: {
      project_id: 'PRJ-CONTEXT-PACK-001',
      name: 'Context Pack Project',
      summary: 'A project used to validate scoped mission context injection.',
      status: 'active',
      tier: 'public',
      tenant_slug: 'acme',
      project_path: 'active/projects/public/acme/PRJ-CONTEXT-PACK-001',
      current_phase: 'design',
      active_track_ids: ['TRK-CONTEXT-PACK-001'],
      active_mission_ids: [missionId],
      active_task_session_ids: ['TSK-CONTEXT-PACK-001'],
      source_refs: ['mission:MSN-CONTEXT-PACK-TEST-001'],
      distill_targets: ['knowledge/product/evolution'],
      knowledge_refs: ['knowledge/product/architecture/mission-context-injection-model.md'],
      last_distilled_at: '2026-06-05T00:00:00.000Z',
    },
    trackRecord: {
      track_id: 'TRK-CONTEXT-PACK-001',
      project_id: 'PRJ-CONTEXT-PACK-001',
      name: 'Context Pack Track',
      summary: 'Tracks context injection work.',
      status: 'active',
      track_type: 'delivery',
      lifecycle_model: 'sdlc',
      tier: 'public',
      active_mission_ids: [missionId],
      required_artifacts: ['mission-context-pack.schema.json'],
    },
    taskSession: {
      session_id: 'TSK-CONTEXT-PACK-001',
      surface: 'presence',
      task_type: 'analysis',
      status: 'executing',
      mode: 'delegated',
      goal: {
        summary: 'Validate mission context packing',
        success_condition: 'pack can be rendered and saved',
      },
      project_context: {
        project_id: 'PRJ-CONTEXT-PACK-001',
        project_name: 'Context Pack Project',
        track_id: 'TRK-CONTEXT-PACK-001',
        track_name: 'Context Pack Track',
        tier: 'public',
        locale: 'ja-JP',
      },
      requirements: {
        missing: [],
        collected: {
          context_pack: true,
        },
      },
      artifact: {
        kind: 'markdown',
        output_path: 'deliverables/context-pack.md',
      },
      control: {
        interruptible: true,
        requires_approval: false,
        awaiting_user_input: false,
      },
      outcome_contract: {
        outcome_id: 'outcome-context-pack-session',
        requested_result: 'mission context pack',
        deliverable_kind: 'artifact',
        success_criteria: ['context pack is scoped'],
        evidence_required: true,
        expected_artifacts: [{ kind: 'markdown', storage_class: 'mission' }],
        verification_method: 'self_check',
      },
      updated_at: '2026-06-05T00:00:00.000Z',
    },
    workItem: {
      item_id: 'WIT-CONTEXT-PACK-001',
      title: 'Implement context pack injection',
      description: 'Build the scoped mission context pack and use it in the work item dispatch prompt.',
      status: 'ready',
      priority: 'high',
      source: 'local',
      source_ref: `mission:${missionId}:task-1`,
      project_id: 'PRJ-CONTEXT-PACK-001',
      assignee_peer_id: 'implementation-architect',
      labels: [`mission:${missionId}`, 'team_role:implementer'],
      dependencies: [],
      metadata: {
        mission_id: missionId,
        team_role: 'implementer',
        deliverable: 'knowledge/product/architecture/mission-context-injection-model.md',
        target_path: 'knowledge/product/architecture/mission-context-injection-model.md',
      },
    },
    missionTeamAssignment: {
      team_role: 'implementer',
      required: true,
      status: 'assigned',
      agent_id: 'implementation-architect',
      authority_role: 'implementation-architect',
      delegation_contract: {
        ownership_scope: 'mission-context-pack',
        allowed_delegate_team_roles: ['reviewer'],
        escalation_parent_team_role: null,
        required_scope_classes: ['mission', 'task'],
        resolved_scope_classes: ['mission', 'task'],
        allowed_write_scopes: ['active/missions/public'],
      },
      provider: 'anthropic',
      modelId: 'claude-4',
      required_capabilities: ['architecture', 'typescript'],
      notes: 'test assignment',
    },
    knowledgeHints: [
      {
        path: 'knowledge/product/architecture/context-precedence-protocol.md',
        title: 'Context Precedence Protocol',
        excerpt: 'Kyberion reads context in tiers.',
        tags: ['context', 'tier'],
        score: 0.91,
        category: 'architecture',
        source_mission: 'MSN-REFERENCE-001',
        last_updated: '2026-06-01T00:00:00.000Z',
      },
    ],
  });
}

function makePrunablePack(): MissionContextPack {
  return buildMissionContextPack({
    contextPackId: 'CPK-MSN-CONTEXT-PACK-TEST-PRUNED-ABC12345',
    contextBudgetChars: 900,
    missionPath,
    missionState: {
      mission_id: `${missionId}-PRUNED`,
      mission_type: 'product_development',
      tier: 'public',
      status: 'active',
      assigned_persona: 'worker',
      tenant_slug: 'acme',
      execution_mode: 'delegated',
      priority: 3,
      confidence_score: 1,
      git: {
        branch: 'mission/context-pack-test',
        start_commit: 'start-commit',
        latest_commit: 'latest-commit',
        checkpoints: [],
      },
      history: [
        {
          ts: '2026-06-05T00:00:00.000Z',
          event: 'create',
          note: 'Mission created for pruning validation',
        },
      ],
      vision_ref: 'vision://context-pack',
      relationships: {
        project: {
          project_id: 'PRJ-CONTEXT-PACK-PRUNED',
          project_path: 'active/projects/public/acme/PRJ-CONTEXT-PACK-PRUNED/project-os',
          relationship_type: 'supports',
          affected_artifacts: ['knowledge/product/architecture/mission-context-injection-model.md'],
          gate_impact: 'informational',
          traceability_refs: ['trace:mission:context-pack'],
          note: 'Context pack pruning project',
        },
        track: {
          track_id: 'TRK-CONTEXT-PACK-PRUNED',
          track_name: 'Context Pack Track',
          track_type: 'delivery',
          lifecycle_model: 'sdlc',
          relationship_type: 'belongs_to',
          traceability_refs: ['trace:track:context-pack'],
          note: 'Context pack pruning track',
        },
      },
      context: {
        last_action: 'record-task',
        next_step: 'dispatch-workitems',
        routing_decision_summary: 'scope minimal context to implementer only',
      },
      outcome_contract: {
        outcome_id: 'outcome-context-pack',
        requested_result: 'Scoped mission context pack',
        deliverable_kind: 'architecture-doc',
        success_criteria: ['pack is role-scoped', 'pack is traceable'],
        evidence_required: true,
      },
    },
    teamRole: 'implementer',
    recipientKind: 'agent',
    assigneePeerId: 'implementation-architect',
    projectState: {
      project_id: 'PRJ-CONTEXT-PACK-PRUNED',
      name: 'Context Pack Project',
      summary: 'A project used to validate scoped mission context injection with pruning. '.repeat(10),
      status: 'active',
      tier: 'public',
      tenant_slug: 'acme',
      project_path: 'active/projects/public/acme/PRJ-CONTEXT-PACK-PRUNED',
      current_phase: 'design',
      active_track_ids: ['TRK-CONTEXT-PACK-PRUNED'],
      active_mission_ids: [`${missionId}-PRUNED`],
      active_task_session_ids: ['TSK-CONTEXT-PACK-PRUNED'],
      source_refs: ['mission:MSN-CONTEXT-PACK-TEST-PRUNED'],
      distill_targets: ['knowledge/product/evolution'],
      knowledge_refs: ['knowledge/product/architecture/mission-context-injection-model.md'],
      last_distilled_at: '2026-06-05T00:00:00.000Z',
    },
    trackRecord: {
      track_id: 'TRK-CONTEXT-PACK-PRUNED',
      project_id: 'PRJ-CONTEXT-PACK-PRUNED',
      name: 'Context Pack Track',
      summary: 'Tracks context injection work and pruning rollups. '.repeat(10),
      status: 'active',
      track_type: 'delivery',
      lifecycle_model: 'sdlc',
      tier: 'public',
      active_mission_ids: [`${missionId}-PRUNED`],
      required_artifacts: ['mission-context-pack.schema.json'],
    },
    taskSession: {
      session_id: 'TSK-CONTEXT-PACK-PRUNED',
      surface: 'presence',
      task_type: 'analysis',
      status: 'executing',
      mode: 'delegated',
      goal: {
        summary: 'Validate mission context packing with pruning and rollup generation. '.repeat(8),
        success_condition: 'pack can be rendered and saved',
      },
      project_context: {
        project_id: 'PRJ-CONTEXT-PACK-PRUNED',
        project_name: 'Context Pack Project',
        track_id: 'TRK-CONTEXT-PACK-PRUNED',
        track_name: 'Context Pack Track',
        tier: 'public',
        locale: 'ja-JP',
      },
      requirements: {
        missing: [],
        collected: {
          context_pack: true,
        },
      },
      artifact: {
        kind: 'markdown',
        output_path: 'deliverables/context-pack.md',
      },
      control: {
        interruptible: true,
        requires_approval: false,
        awaiting_user_input: false,
      },
      outcome_contract: {
        outcome_id: 'outcome-context-pack-session',
        requested_result: 'mission context pack',
        deliverable_kind: 'artifact',
        success_criteria: ['context pack is scoped'],
        evidence_required: true,
        expected_artifacts: [{ kind: 'markdown', storage_class: 'mission' }],
        verification_method: 'self_check',
      },
      updated_at: '2026-06-05T00:00:00.000Z',
    },
    workItem: {
      item_id: 'WIT-CONTEXT-PACK-PRUNED',
      title: 'Implement context pack pruning',
      description: 'Build the scoped mission context pack and use it in the work item dispatch prompt. '.repeat(12),
      status: 'ready',
      priority: 'high',
      source: 'local',
      source_ref: `mission:${missionId}-PRUNED:task-1`,
      project_id: 'PRJ-CONTEXT-PACK-PRUNED',
      assignee_peer_id: 'implementation-architect',
      labels: [`mission:${missionId}-PRUNED`, 'team_role:implementer'],
      dependencies: [],
      metadata: {
        mission_id: `${missionId}-PRUNED`,
        team_role: 'implementer',
        deliverable: 'knowledge/product/architecture/mission-context-injection-model.md',
        target_path: 'knowledge/product/architecture/mission-context-injection-model.md',
      },
    },
    missionTeamAssignment: {
      team_role: 'implementer',
      required: true,
      status: 'assigned',
      agent_id: 'implementation-architect',
      authority_role: 'implementation-architect',
      delegation_contract: {
        ownership_scope: 'mission-context-pack',
        allowed_delegate_team_roles: ['reviewer'],
        escalation_parent_team_role: null,
        required_scope_classes: ['mission', 'task'],
        resolved_scope_classes: ['mission', 'task'],
        allowed_write_scopes: ['active/missions/public'],
      },
      provider: 'anthropic',
      modelId: 'claude-4',
      required_capabilities: ['architecture', 'typescript'],
      notes: 'test assignment',
    },
    knowledgeHints: Array.from({ length: 6 }, (_, index) => ({
      path: `knowledge/product/architecture/context-precedence-protocol-${index}.md`,
      title: `Context Precedence Protocol ${index}`,
      excerpt: 'Kyberion reads context in tiers. '.repeat(30),
      tags: ['context', 'tier'],
      score: 0.91 - index * 0.01,
      category: 'architecture',
      source_mission: 'MSN-REFERENCE-001',
      last_updated: '2026-06-01T00:00:00.000Z',
    })),
  });
}

describe('mission-context-pack', () => {
  it('builds a scoped role-specific pack with traceable sources', () => {
    const pack = makePack();

    expect(pack).toMatchObject({
      context_pack_id: 'CPK-MSN-CONTEXT-PACK-TEST-001-IMPLEMENTER-ABC12345',
      version: '1',
    });
    expect(pack.scope).toMatchObject({
      mission_id: missionId,
      tier: 'public',
      tenant_slug: 'acme',
      project_id: 'PRJ-CONTEXT-PACK-001',
      track_id: 'TRK-CONTEXT-PACK-001',
      task_session_id: 'TSK-CONTEXT-PACK-001',
      work_item_id: 'WIT-CONTEXT-PACK-001',
    });
    expect(pack.recipient).toMatchObject({
      kind: 'agent',
      team_role: 'implementer',
      agent_id: 'implementation-architect',
      authority_role: 'implementation-architect',
    });
    expect(pack.project?.project_id).toBe('PRJ-CONTEXT-PACK-001');
    expect(pack.track?.track_id).toBe('TRK-CONTEXT-PACK-001');
    expect(pack.task_session?.session_id).toBe('TSK-CONTEXT-PACK-001');
    expect(pack.work_item?.item_id).toBe('WIT-CONTEXT-PACK-001');
    expect(pack.knowledge_hints).toHaveLength(1);
    expect(pack.sources.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      'mission_state',
      'mission_team',
      'project_state',
      'project_track',
      'task_session',
      'work_item',
      'knowledge_hint',
    ]));

    const rendered = renderMissionContextPack(pack);
    expect(rendered).toContain('Mission context pack (scoped, minimal, role-specific).');
    expect(rendered).toContain('Use only the facts in this pack');
    expect(rendered).toContain('Implement context pack injection');
  });

  it('saves the pack in mission-local coordination storage', () => {
    const pack = makePack();
    const filePath = saveMissionContextPack(missionPath, pack);

    expect(filePath).toContain('/coordination/context-packs/');
    expect(safeExistsSync(filePath)).toBe(true);

    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as MissionContextPack & { context_pack_path?: string };
    expect(parsed).toMatchObject({
      context_pack_id: pack.context_pack_id,
      context_pack_path: filePath,
      mission: {
        mission_id: missionId,
      },
    });
  });

  it('injects reusable artifact hints without binding the artifact to the mission', () => {
    appendArtifactOwnershipRecord(createArtifactOwnershipRecord({
      artifact_id: 'ART-CONTEXT-PACK-BASE',
      project_id: 'PRJ-CONTEXT-PACK-001',
      mission_id: 'MSN-CONTEXT-PACK-BASE',
      kind: 'markdown',
      storage_class: 'artifact_store',
      path: 'active/shared/artifacts/context-pack-base.md',
      created_at: '2026-06-04T00:00:00.000Z',
    }));
    appendArtifactOwnershipRecord(createArtifactOwnershipRecord({
      artifact_id: 'ART-CONTEXT-PACK-REVISION',
      project_id: 'PRJ-CONTEXT-PACK-001',
      mission_id: 'MSN-CONTEXT-PACK-REVISION',
      kind: 'markdown',
      storage_class: 'artifact_store',
      path: 'active/shared/artifacts/context-pack-revision.md',
      created_at: '2026-06-05T00:00:00.000Z',
      evidence_refs: ['mission:MSN-CONTEXT-PACK-REVISION'],
    }));

    const pack = makePack();
    expect(pack.artifact_hints?.[0]?.artifact_id).toBe('ART-CONTEXT-PACK-REVISION');
    expect(pack.artifact_hints?.[0]?.reuse_reason).toContain('Reusable project artifact');
    expect(pack.artifact_hints?.every((hint) => hint.project_id === 'PRJ-CONTEXT-PACK-001')).toBe(true);
  });

  it('prunes oversized context packs and writes a mission-local rollup', () => {
    const pack = makePrunablePack();

    expect(pack.pruning).toMatchObject({
      budget_chars: 900,
    });
    expect(pack.pruning?.pruned_sections.length).toBeGreaterThan(0);
    expect(pack.pruning?.rollup_summary).toContain('Pruned sections');
    expect(pack.pruning?.rollup_path).toContain('/coordination/context-rollups/');
    expect(pack.knowledge_hints?.length).toBeLessThanOrEqual(3);
    expect(pack.artifact_hints?.length ?? 0).toBeLessThanOrEqual(2);

    const rollupPath = pack.pruning?.rollup_path;
    expect(rollupPath).toBeDefined();
    expect(safeExistsSync(String(rollupPath))).toBe(true);
    const rollup = safeReadFile(String(rollupPath), { encoding: 'utf8' }) as string;
    expect(rollup).toContain('Mission context rollup');
    expect(rollup).toContain('Pruned sections');

    const rendered = renderMissionContextPack(pack);
    expect(rendered).toContain('Context pruning:');
    expect(rendered).toContain('Rollup:');
  });
});
