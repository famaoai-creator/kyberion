import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export type VoiceTaskDistillTargetKind = 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';

export interface VoiceTaskProfileEntry {
  id: string;
  task_type: string;
  bootstrap_kind?: string;
  analysis_kind?: string;
  report_kind?: string;
  operation?: string;
  distill_target_kind: VoiceTaskDistillTargetKind;
  label_ja?: string;
  label_en?: string;
  accepted_reply_ja?: string;
  accepted_reply_en?: string;
  missing_reply_ja?: string;
  missing_reply_en?: string;
  approval_reply_ja?: string;
  approval_reply_en?: string;
  progress_reply_ja?: string;
  progress_reply_en?: string;
  applicability?: string[];
  reusable_steps?: string[];
  template_sections?: string[];
  audience?: string;
  output_format?: string;
  procedure_steps?: string[];
  safety_notes?: string[];
  escalation_conditions?: string[];
  expected_outcome?: string;
}

interface VoiceTaskProfileCatalog {
  version: string;
  profiles: VoiceTaskProfileEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/voice-task-profile-catalog.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/voice-task-profile-catalog.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: VoiceTaskProfileCatalog | null = null;
let cachedCatalogPath: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateCatalog(value: unknown, label: string): VoiceTaskProfileCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid voice task profile catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as VoiceTaskProfileCatalog;
}

export function loadVoiceTaskProfileCatalog(): VoiceTaskProfileCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = { version: '1.0.0', profiles: [] };
    cachedCatalogPath = CATALOG_PATH;
    return cachedCatalog;
  }
  const parsed = validateCatalog(
    JSON.parse(safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string),
    CATALOG_PATH
  );
  cachedCatalog = parsed;
  cachedCatalogPath = CATALOG_PATH;
  return parsed;
}

export function listVoiceTaskProfiles(): VoiceTaskProfileEntry[] {
  return loadVoiceTaskProfileCatalog().profiles;
}

export function resolveVoiceTaskProfile(input: {
  taskType: string;
  bootstrapKind?: string;
  analysisKind?: string;
  reportKind?: string;
  operation?: string;
}): VoiceTaskProfileEntry | null {
  const taskType = input.taskType.trim();
  if (!taskType) return null;
  const candidates = listVoiceTaskProfiles().filter((profile) => profile.task_type === taskType);
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((profile, index) => {
      let score = 0;
      if (profile.bootstrap_kind && profile.bootstrap_kind === input.bootstrapKind) score += 8;
      if (profile.analysis_kind && profile.analysis_kind === input.analysisKind) score += 8;
      if (profile.report_kind && profile.report_kind === input.reportKind) score += 8;
      if (profile.operation && profile.operation === input.operation) score += 8;
      if (!profile.bootstrap_kind && !profile.analysis_kind && !profile.report_kind && !profile.operation) score += 1;
      return { profile, score, index };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);

  return scored[0]?.profile || null;
}

export function resolveVoiceTaskDistillTargetKind(input: {
  taskType: string;
  bootstrapKind?: string;
  analysisKind?: string;
  reportKind?: string;
  operation?: string;
}): VoiceTaskDistillTargetKind {
  return resolveVoiceTaskProfile(input)?.distill_target_kind || 'knowledge_hint';
}

export function resetVoiceTaskProfileCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
