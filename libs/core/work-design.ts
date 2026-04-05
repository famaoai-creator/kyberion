import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { listDistillCandidateRecords } from './distill-candidate-registry.js';

export interface OutcomeDefinition {
  id: string;
  label: string;
  description: string;
  deliverable_kind: string;
  downloadable: boolean;
  previewable: boolean;
}

export interface SpecialistDefinition {
  id: string;
  label: string;
  description: string;
  conversation_agent: string;
  team_roles: string[];
  capabilities: string[];
}

interface OutcomeCatalogFile {
  outcomes?: Record<string, Omit<OutcomeDefinition, 'id'>>;
}

interface SpecialistCatalogFile {
  specialists?: Record<string, Omit<SpecialistDefinition, 'id'>>;
}

interface StandardIntentCatalogFile {
  intents?: Array<{
    id?: string;
    category?: string;
    specialist_id?: string;
    outcome_ids?: string[];
    plan_outline?: string[];
    intake_requirements?: string[];
    resolution?: {
      shape?: string;
      task_kind?: string;
      result_shape?: string;
    };
  }>;
}

export interface WorkDesignSummary {
  primary_specialist: SpecialistDefinition | null;
  conversation_agent: string | null;
  team_roles: string[];
  outcomes: OutcomeDefinition[];
  reusable_refs: Array<{
    candidate_id: string;
    title: string;
    target_kind: string;
    promoted_ref?: string;
  }>;
}

export interface OrganizationWorkLoopSummary {
  intent: {
    label: string;
  };
  context: {
    project_id?: string;
    project_name?: string;
    track_id?: string;
    track_name?: string;
    tier: 'personal' | 'confidential' | 'public';
    locale?: string;
    service_bindings: string[];
  };
  resolution: {
    execution_shape: 'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap';
    task_type?: string;
  };
  outcome_design: {
    outcome_ids: string[];
    labels: string[];
  };
  process_design: {
    plan_outline: string[];
    intake_requirements: string[];
    operator_checklist: string[];
  };
  runtime_design: {
    owner_model: 'single_actor' | 'single_owner_multi_worker';
    assignment_policy: 'direct_specialist' | 'lease_aware_capability' | 'dependency_first';
    coordination: {
      bus: 'none' | 'mission_coordination_bus';
      channels: string[];
    };
    memory: {
      store: 'none' | 'mission_working_memory';
      scope: 'none' | 'mission_local';
      purpose: string[];
    };
  };
  execution_boundary: {
    llm_zone: {
      allowed: string[];
      forbidden: string[];
    };
    knowledge_zone: {
      owns: string[];
    };
    compiler_zone: {
      responsibilities: string[];
    };
    executor_zone: {
      responsibilities: string[];
    };
    rule: string;
  };
  teaming: {
    specialist_id?: string;
    specialist_label?: string;
    conversation_agent?: string;
    team_roles: string[];
  };
  authority: {
    requires_approval: boolean;
  };
  learning: {
    reusable_refs: string[];
  };
}

function normalizeKnowledgeTier(value?: string): 'personal' | 'confidential' | 'public' {
  return value === 'personal' || value === 'public' ? value : 'confidential';
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

export function loadOutcomeCatalog(): Record<string, OutcomeDefinition> {
  const parsed = loadJson<OutcomeCatalogFile>(pathResolver.knowledge('public/governance/outcome-catalog.json'));
  const entries = parsed.outcomes || {};
  return Object.fromEntries(
    Object.entries(entries).map(([id, value]) => [id, { id, ...value }]),
  );
}

export function loadSpecialistCatalog(): Record<string, SpecialistDefinition> {
  const parsed = loadJson<SpecialistCatalogFile>(pathResolver.knowledge('public/orchestration/specialist-catalog.json'));
  const entries = parsed.specialists || {};
  return Object.fromEntries(
    Object.entries(entries).map(([id, value]) => [id, { id, ...value }]),
  );
}

function loadStandardIntentCatalog(): StandardIntentCatalogFile['intents'] {
  const parsed = loadJson<StandardIntentCatalogFile>(pathResolver.knowledge('public/governance/standard-intents.json'));
  return Array.isArray(parsed.intents) ? parsed.intents : [];
}

function findIntentDefinition(intentId?: string) {
  if (!intentId) return null;
  return loadStandardIntentCatalog().find((intent) => intent?.id === intentId) || null;
}

function buildProcessDesign(input: {
  intentId?: string;
  taskType?: string;
  shape?: string;
}): OrganizationWorkLoopSummary['process_design'] {
  const intentDefinition = findIntentDefinition(input.intentId);
  const planOutline = Array.isArray(intentDefinition?.plan_outline)
    ? intentDefinition!.plan_outline.map(String).filter(Boolean)
    : [];
  const intakeRequirements = Array.isArray(intentDefinition?.intake_requirements)
    ? intentDefinition!.intake_requirements.map(String).filter(Boolean)
    : [];

  const operatorChecklist = [
    ...planOutline,
    ...(input.shape === 'task_session' || input.taskType
      ? ['confirm the governed output path', 'capture evidence and reusable findings']
      : []),
    ...(input.shape === 'project_bootstrap'
      ? ['confirm project root and default track', 'prepare the first governed work items']
      : []),
  ].filter(Boolean);

  return {
    plan_outline: planOutline,
    intake_requirements: intakeRequirements,
    operator_checklist: operatorChecklist,
  };
}

function buildExecutionBoundary(input: {
  intentId?: string;
  taskType?: string;
  shape?: string;
}): OrganizationWorkLoopSummary['execution_boundary'] {
  const isAnalysis =
    input.intentId === 'incident-informed-review' ||
    input.intentId === 'cross-project-remediation' ||
    input.taskType === 'analysis';

  if (isAnalysis) {
    return {
      llm_zone: {
        allowed: [
          'normalize_analysis_request',
          'draft_findings_language',
          'summarize_incident_or_requirement_history',
          'propose_follow_up_work_items',
        ],
        forbidden: [
          'override_governed_process_design',
          'invent_review_target_bindings',
          'mutate_repo_or_mission_state_directly',
          'declare_verification_complete_without_evidence',
        ],
      },
      knowledge_zone: {
        owns: [
          'intent definitions',
          'process_design',
          'outcome catalog',
          'specialist routing',
        ],
      },
      compiler_zone: {
        responsibilities: [
          'resolve_target_binding',
          'rank_governed_refs',
          'classify_impact_bands',
          'build_finding_candidates_and_execution_contract',
        ],
      },
      executor_zone: {
        responsibilities: [
          'persist_analysis_artifact',
          'create_follow_up_seeds',
          'preserve_governed_project_track_context',
        ],
      },
      rule: 'LLM drafts findings language; knowledge defines process; compiler binds targets and findings; executors persist artifacts and seeds',
    };
  }

  return {
    llm_zone: {
      allowed: [
        'normalize_request',
        'draft_content_within_governed_slots',
        'explain_next_action',
      ],
      forbidden: [
        'override_governed_structure',
        'invent_low_level_execution_contracts',
        'declare_completion_without_evidence',
      ],
    },
    knowledge_zone: {
      owns: [
        'intent definitions',
        'process_design',
        'outcome catalog',
        'specialist routing',
      ],
    },
    compiler_zone: {
      responsibilities: [
        'map_intent_to_governed_execution_shape',
        'prepare_contracts_and_paths',
      ],
    },
    executor_zone: {
      responsibilities: [
        'perform_governed_execution',
        'persist_evidence',
        'preserve_reproducibility',
      ],
    },
    rule: 'LLM drafts within governed slots; knowledge defines process; compiler shapes execution; executors persist and reproduce',
  };
}

function buildRuntimeDesign(input: {
  intentId?: string;
  taskType?: string;
  shape?: string;
}): OrganizationWorkLoopSummary['runtime_design'] {
  const isCollaborative =
    input.shape === 'mission' ||
    input.shape === 'project_bootstrap' ||
    input.intentId === 'bootstrap-project' ||
    input.intentId === 'incident-informed-review' ||
    input.intentId === 'cross-project-remediation' ||
    input.taskType === 'analysis';

  if (isCollaborative) {
    return {
      owner_model: 'single_owner_multi_worker',
      assignment_policy: input.shape === 'mission' ? 'dependency_first' : 'lease_aware_capability',
      coordination: {
        bus: 'mission_coordination_bus',
        channels: ['task_contract', 'handoff', 'review', 'runtime_notice'],
      },
      memory: {
        store: 'mission_working_memory',
        scope: 'mission_local',
        purpose: [
          'transient worker coordination',
          'intermediate findings and review notes',
          'owner synthesis inputs before durable promotion',
        ],
      },
    };
  }

  return {
    owner_model: 'single_actor',
    assignment_policy: 'direct_specialist',
    coordination: {
      bus: 'none',
      channels: [],
    },
    memory: {
      store: 'none',
      scope: 'none',
      purpose: [],
    },
  };
}

function inferExecutionShape(input: {
  intentId?: string;
  taskType?: string;
  shape?: string;
  projectId?: string;
}): OrganizationWorkLoopSummary['resolution']['execution_shape'] {
  if (input.shape === 'project_bootstrap' || input.intentId === 'bootstrap-project') {
    return 'project_bootstrap';
  }
  if (input.shape === 'mission') {
    return 'mission';
  }
  if (input.taskType) {
    return 'task_session';
  }
  return 'direct_reply';
}

function inferIntentLabel(input: {
  intentId?: string;
  taskType?: string;
  queryType?: string;
}): string {
  if (input.intentId === 'bootstrap-project') return 'Project bootstrap';
  if (input.intentId) return input.intentId;
  if (input.taskType) return input.taskType;
  if (input.queryType) return input.queryType;
  return 'general_request';
}

function specialistIdForIntent(input: {
  intentId?: string;
  taskType?: string;
  queryType?: string;
  shape?: string;
}): string {
  const intentDefinition = findIntentDefinition(input.intentId);
  if (typeof intentDefinition?.specialist_id === 'string' && intentDefinition.specialist_id.trim()) {
    return intentDefinition.specialist_id;
  }
  if (input.intentId === 'bootstrap-project' || input.shape === 'project_bootstrap') {
    return 'project-lead';
  }
  if (input.intentId === 'open-site' || input.intentId === 'browser-step' || input.shape === 'browser_session') {
    return 'browser-operator';
  }
  if (
    input.intentId === 'generate-presentation' ||
    input.intentId === 'generate-report' ||
    input.intentId === 'generate-workbook' ||
    ['presentation_deck', 'report_document', 'workbook_wbs'].includes(String(input.taskType || ''))
  ) {
    return 'document-specialist';
  }
  if (input.intentId === 'inspect-service' || input.taskType === 'service_operation') {
    return 'service-operator';
  }
  if (
    input.intentId === 'knowledge-query' ||
    input.intentId === 'live-query' ||
    ['knowledge_search', 'web_search', 'weather', 'location'].includes(String(input.queryType || ''))
  ) {
    return 'knowledge-specialist';
  }
  return 'surface-concierge';
}

export function resolveWorkDesign(input: {
  intentId?: string;
  taskType?: string;
  queryType?: string;
  shape?: string;
  outcomeIds?: string[];
  tier?: 'personal' | 'confidential' | 'public';
}): WorkDesignSummary {
  const specialists = loadSpecialistCatalog();
  const outcomes = loadOutcomeCatalog();
  const intentDefinition = findIntentDefinition(input.intentId);
  const primary = specialists[specialistIdForIntent(input)] || null;
  const requestedOutcomeIds = (input.outcomeIds && input.outcomeIds.length)
    ? input.outcomeIds
    : (Array.isArray(intentDefinition?.outcome_ids) ? intentDefinition.outcome_ids : []);
  const tier = normalizeKnowledgeTier(input.tier);
  const resolvedOutcomes = requestedOutcomeIds
    .map((id) => outcomes[id])
    .filter((value): value is OutcomeDefinition => Boolean(value));
  const reusableRefs = listDistillCandidateRecords()
    .filter((candidate) => candidate.status === 'promoted')
    .filter((candidate) => normalizeKnowledgeTier(candidate.tier) === tier)
    .filter((candidate) => {
      if (primary?.id && candidate.specialist_id && candidate.specialist_id === primary.id) return true;
      if (input.taskType && candidate.metadata?.task_type === input.taskType) return true;
      if (requestedOutcomeIds.length && requestedOutcomeIds.some((id) => candidate.summary.includes(id) || candidate.evidence_refs?.some((ref) => ref.includes(id)))) return true;
      return false;
    })
    .slice(0, 4)
    .map((candidate) => ({
      candidate_id: candidate.candidate_id,
      title: candidate.title,
      target_kind: candidate.target_kind,
      promoted_ref: candidate.promoted_ref,
    }));

  return {
    primary_specialist: primary,
    conversation_agent: primary?.conversation_agent || null,
    team_roles: primary?.team_roles || [],
    outcomes: resolvedOutcomes,
    reusable_refs: reusableRefs,
  };
}

export function buildOrganizationWorkLoopSummary(input: {
  intentId?: string;
  taskType?: string;
  queryType?: string;
  shape?: string;
  outcomeIds?: string[];
  tier?: 'personal' | 'confidential' | 'public';
  projectId?: string;
  projectName?: string;
  trackId?: string;
  trackName?: string;
  locale?: string;
  serviceBindings?: string[];
  requiresApproval?: boolean;
}): OrganizationWorkLoopSummary {
  const tier = normalizeKnowledgeTier(input.tier);
  const design = resolveWorkDesign({
    intentId: input.intentId,
    taskType: input.taskType,
    queryType: input.queryType,
    shape: input.shape,
    outcomeIds: input.outcomeIds,
    tier,
  });
  return {
    intent: {
      label: inferIntentLabel(input),
    },
    context: {
      project_id: input.projectId,
      project_name: input.projectName,
      track_id: input.trackId,
      track_name: input.trackName,
      tier,
      locale: input.locale,
      service_bindings: Array.isArray(input.serviceBindings) ? input.serviceBindings : [],
    },
    resolution: {
      execution_shape: inferExecutionShape(input),
      task_type: input.taskType,
    },
    outcome_design: {
      outcome_ids: design.outcomes.map((outcome) => outcome.id),
      labels: design.outcomes.map((outcome) => outcome.label),
    },
    process_design: buildProcessDesign(input),
    runtime_design: buildRuntimeDesign(input),
    execution_boundary: buildExecutionBoundary(input),
    teaming: {
      specialist_id: design.primary_specialist?.id,
      specialist_label: design.primary_specialist?.label,
      conversation_agent: design.conversation_agent || undefined,
      team_roles: design.team_roles,
    },
    authority: {
      requires_approval: Boolean(input.requiresApproval),
    },
    learning: {
      reusable_refs: design.reusable_refs.map((ref) => ref.promoted_ref || ref.title),
    },
  };
}
