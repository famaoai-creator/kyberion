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

export interface MissionWorkflowSelectionInput {
  missionClass: MissionClass;
  deliveryShape: MissionDeliveryShape;
  riskProfile: MissionRiskProfile;
  stage: MissionStage;
  executionShape: 'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap';
  intentId?: string;
  taskType?: string;
}

export interface MissionWorkflowDesign {
  workflow_id: string;
  pattern: string;
  stage: MissionStage;
  phases: string[];
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
  phases: string[];
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
const WORKFLOW_CATALOG_SCHEMA_PATH = pathResolver.knowledge('public/schemas/mission-workflow-catalog.schema.json');
const WORKFLOW_CATALOG_PATH = pathResolver.knowledge('public/governance/mission-workflow-catalog.json');

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
  return Array.from(new Set((values || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
}

function matchesValue(value: string | undefined, allowed: string[] | undefined): boolean {
  if (!allowed?.length) return true;
  if (!value) return false;
  return allowed.includes('*') || allowed.includes(value);
}

function templateMatches(input: {
  missionClass: string;
  deliveryShape: string;
  riskProfile: string;
  executionShape: string;
  intentId?: string;
  taskType?: string;
}, template: WorkflowTemplate): boolean {
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

function loadWorkflowCatalog(): WorkflowCatalogFile {
  const parsed = JSON.parse(safeReadFile(WORKFLOW_CATALOG_PATH, { encoding: 'utf8' }) as string) as WorkflowCatalogFile;
  const validate = ensureWorkflowCatalogValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid mission-workflow-catalog: ${errors}`);
  }
  return parsed;
}

export function resolveMissionWorkflowDesign(input: MissionWorkflowSelectionInput): MissionWorkflowDesign {
  const catalog = loadWorkflowCatalog();
  const normalizedInput = {
    missionClass: normalize(input.missionClass) || 'code_change',
    deliveryShape: normalize(input.deliveryShape) || 'single_artifact',
    riskProfile: normalize(input.riskProfile) || 'review_required',
    executionShape: normalize(input.executionShape) || 'task_session',
    intentId: normalize(input.intentId),
    taskType: normalize(input.taskType),
  };

  const selected = catalog.templates.find((template) => templateMatches(normalizedInput, template))
    || catalog.templates.find((template) => template.id === catalog.defaults.workflow_id);

  if (!selected) {
    throw new Error(`Missing default workflow template: ${catalog.defaults.workflow_id}`);
  }

  return {
    workflow_id: selected.id,
    pattern: selected.pattern,
    stage: input.stage,
    phases: selected.phases,
    rationale: selected.description || `Selected workflow ${selected.id} by mission classification and execution shape.`,
  };
}
