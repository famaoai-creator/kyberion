import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export type VoiceTaskDistillTargetKind =
  'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';

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

const CATALOG_PATH = pathResolver.knowledge('product/governance/voice-task-profile-catalog.json');
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/voice-task-profile-catalog.schema.json'
);

const catalog = defineCatalog<VoiceTaskProfileCatalog>({
  id: 'voice-task-profile-catalog',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: { version: '1.0.0', profiles: [] },
});

export function loadVoiceTaskProfileCatalog(): VoiceTaskProfileCatalog {
  return catalog.load();
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
      if (
        !profile.bootstrap_kind &&
        !profile.analysis_kind &&
        !profile.report_kind &&
        !profile.operation
      )
        score += 1;
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
