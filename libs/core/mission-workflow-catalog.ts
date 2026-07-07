import AjvModule, { type ValidateFunction } from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import type {
  MissionClass,
  MissionDeliveryShape,
  MissionRiskProfile,
  MissionStage,
} from './mission-classification.js';
import {
  normalizeExecutionShape,
  projectExecutionShapeToWorkflowShape,
  type ExecutionShape,
  type WorkflowExecutionShape,
} from './execution-shape.js';

export interface MissionWorkflowSelectionInput {
  missionClass: MissionClass;
  deliveryShape: MissionDeliveryShape;
  riskProfile: MissionRiskProfile;
  stage: MissionStage;
  executionShape: ExecutionShape;
  missionTypeHint?: string;
  intentId?: string;
  taskType?: string;
}

export type WorkflowPhaseGateCheckKind =
  | 'evidence_exists'
  | 'schema_valid'
  | 'command_succeeds'
  | 'reviewer_approved'
  | 'human_override'
  | 'deliverable_quality'
  | 'custom';

export interface WorkflowPhaseGateCheck {
  kind: WorkflowPhaseGateCheckKind;
  params?: Record<string, unknown>;
}

export interface WorkflowPhaseGate {
  id: string;
  title?: string;
  checks: WorkflowPhaseGateCheck[];
}

export interface WorkflowPhaseTaskSpec {
  task_id_suffix: string;
  description: string;
  team_role?: string;
  phase_kind?: 'implement' | 'review';
  deliverable?: string;
  acceptance_criteria?: string[];
  risk?: 'low' | 'medium' | 'high' | 'approval_required' | 'high_stakes';
  estimated_scope?: 'S' | 'M' | 'L';
  expected_output_format?: 'text' | 'files' | 'structured';
  review_target_suffix?: string;
  deliverable_kind?: 'doc' | 'deck' | 'code' | 'media';
  pipeline_ref?: string;
}

export interface WorkflowPhaseSpec {
  id: string;
  title?: string;
  kind?: 'judgment' | 'deterministic' | 'review' | 'approval';
  pipeline_ref?: string;
  brief_ref?: string;
  entry_gate?: WorkflowPhaseGate;
  exit_gate?: WorkflowPhaseGate;
  default_tasks?: WorkflowPhaseTaskSpec[];
}

export type WorkflowPhase = string | WorkflowPhaseSpec;

export interface MissionWorkflowDesign {
  workflow_id: string;
  pattern: string;
  stage: MissionStage;
  phases: string[];
  phase_specs?: WorkflowPhaseSpec[];
  rationale: string;
}

type WorkflowMatch = {
  mission_classes?: string[];
  delivery_shapes?: string[];
  risk_profiles?: string[];
  execution_shapes?: string[];
  intent_ids?: string[];
  task_types?: string[];
};

type WorkflowTemplate = {
  id: string;
  pattern: string;
  description?: string;
  match?: WorkflowMatch;
  phases: WorkflowPhase[];
};

type WorkflowCatalogFile = {
  version: string;
  defaults: {
    workflow_id: string;
  };
  patterns: Record<string, { description: string }>;
  templates: WorkflowTemplate[];
};

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const WORKFLOW_CATALOG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-workflow-catalog.schema.json'
);
const WORKFLOW_CATALOG_PATH = pathResolver.knowledge(
  'product/governance/mission-workflow-catalog.json'
);

let workflowCatalogValidateFn: ValidateFunction | null = null;

function ensureWorkflowCatalogValidator(): ValidateFunction {
  if (workflowCatalogValidateFn) return workflowCatalogValidateFn;
  workflowCatalogValidateFn = compileSchemaFromPath(ajv, WORKFLOW_CATALOG_SCHEMA_PATH);
  return workflowCatalogValidateFn;
}

function normalize(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length ? trimmed : undefined;
}

function normalizeArray(values?: string[]): string[] {
  return Array.from(
    new Set(
      (values || [])
        .map((value) =>
          String(value || '')
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    )
  );
}

function matchesValue(value: string | undefined, allowed: string[] | undefined): boolean {
  if (!allowed?.length) return true;
  if (!value) return false;
  return allowed.includes('*') || allowed.includes(value);
}

function templateMatches(
  input: {
    missionClass: string;
    deliveryShape: string;
    riskProfile: string;
    executionShape: WorkflowExecutionShape;
    intentId?: string;
    taskType?: string;
  },
  template: WorkflowTemplate
): boolean {
  const match = template.match;
  if (!match) return false;
  return (
    matchesValue(input.missionClass, normalizeArray(match.mission_classes)) &&
    matchesValue(input.deliveryShape, normalizeArray(match.delivery_shapes)) &&
    matchesValue(input.riskProfile, normalizeArray(match.risk_profiles)) &&
    matchesValue(input.executionShape, normalizeArray(match.execution_shapes)) &&
    matchesValue(input.intentId, normalizeArray(match.intent_ids)) &&
    matchesValue(input.taskType, normalizeArray(match.task_types))
  );
}

export function normalizeWorkflowPhases(phases: WorkflowPhase[]): {
  ids: string[];
  specs: WorkflowPhaseSpec[];
  hasSpecEntries: boolean;
} {
  const ids: string[] = [];
  const specs: WorkflowPhaseSpec[] = [];
  let hasSpecEntries = false;
  for (const phase of phases) {
    if (typeof phase === 'string') {
      ids.push(phase);
      specs.push({ id: phase });
      continue;
    }
    hasSpecEntries = true;
    ids.push(phase.id);
    specs.push(phase);
  }
  return { ids, specs, hasSpecEntries };
}

function loadWorkflowCatalog(): WorkflowCatalogFile {
  const parsed = JSON.parse(
    safeReadFile(WORKFLOW_CATALOG_PATH, { encoding: 'utf8' }) as string
  ) as WorkflowCatalogFile;
  const validate = ensureWorkflowCatalogValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid mission-workflow-catalog: ${errors}`);
  }
  return parsed;
}

export function resolveMissionWorkflowDesign(
  input: MissionWorkflowSelectionInput
): MissionWorkflowDesign {
  const catalog = loadWorkflowCatalog();
  const projectedExecutionShape = projectExecutionShapeToWorkflowShape(
    normalizeExecutionShape(input.executionShape)
  );
  const missionTypeHint = normalize(input.missionTypeHint);
  const meetingFacilitationHint = missionTypeHint === 'meeting_facilitation';
  // Mission-type hints route type-first creations (`mission create <tier>
  // <tenant> <type>`) onto their dedicated process templates when the intent
  // id is not supplied explicitly.
  const hintDefaults: Record<
    string,
    { missionClass?: string; deliveryShape?: string; intentId?: string; taskType?: string }
  > = {
    meeting_facilitation: {
      deliveryShape: 'multi_artifact_pipeline',
      intentId: 'meeting-operations',
      taskType: 'meeting_operations',
    },
    presentation_production: {
      missionClass: 'content_and_media',
      intentId: 'presentation-deck',
      taskType: 'presentation_production',
    },
    document_production: {
      missionClass: 'content_and_media',
      intentId: 'document-authoring',
      taskType: 'document_production',
    },
    incident_analysis: {
      missionClass: 'operations_and_release',
      intentId: 'incident-analysis',
      taskType: 'incident_analysis',
    },
    research_report: {
      missionClass: 'research_and_absorption',
      intentId: 'research-report',
      taskType: 'research_report',
    },
    data_analysis: {
      missionClass: 'decision_support',
      intentId: 'data-analysis',
      taskType: 'data_analysis',
    },
    marketing_campaign: {
      missionClass: 'content_and_media',
      intentId: 'marketing-campaign',
      taskType: 'marketing_campaign',
    },
    contract_review: {
      missionClass: 'decision_support',
      intentId: 'contract-review',
      taskType: 'contract_review',
    },
    customer_onboarding: {
      missionClass: 'customer_engagement',
      intentId: 'customer-onboarding',
      taskType: 'customer_onboarding',
    },
    training_material: {
      missionClass: 'content_and_media',
      intentId: 'training-material',
      taskType: 'training_material',
    },
    event_planning: {
      missionClass: 'operations_and_release',
      deliveryShape: 'multi_artifact_pipeline',
      intentId: 'event-planning',
      taskType: 'event_planning',
    },
  };
  const hint = missionTypeHint ? hintDefaults[missionTypeHint] : undefined;
  const normalizedInput = {
    missionClass: normalize(input.missionClass) || hint?.missionClass || 'code_change',
    deliveryShape:
      normalize(input.deliveryShape) ||
      hint?.deliveryShape ||
      (meetingFacilitationHint ? 'multi_artifact_pipeline' : 'single_artifact'),
    riskProfile: normalize(input.riskProfile) || 'review_required',
    executionShape: projectedExecutionShape,
    intentId: normalize(input.intentId) || hint?.intentId,
    taskType: normalize(input.taskType) || hint?.taskType,
  };

  const selected =
    catalog.templates.find((template) => templateMatches(normalizedInput, template)) ||
    catalog.templates.find((template) => template.id === catalog.defaults.workflow_id);

  if (!selected) {
    throw new Error(`Missing default workflow template: ${catalog.defaults.workflow_id}`);
  }

  const { ids, specs, hasSpecEntries } = normalizeWorkflowPhases(selected.phases);
  return {
    workflow_id: selected.id,
    pattern: selected.pattern,
    stage: input.stage,
    phases: ids,
    ...(hasSpecEntries ? { phase_specs: specs } : {}),
    rationale:
      selected.description ||
      `Selected workflow ${selected.id} by mission classification and execution shape.`,
  };
}
