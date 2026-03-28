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
