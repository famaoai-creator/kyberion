import {
  evaluateArchitectureReadyGate,
  evaluateCustomerSignoffGate,
  evaluateQaReadyGate,
  evaluateRequirementsCompletenessGate,
  getReasoningBackend,
  pathResolver,
  readDesignSpec,
  readRequirementsDraft,
  safeExistsSync,
  safeReadFile,
  saveDesignSpec,
  saveRequirementsDraft,
  saveTestPlan,
} from '@agent/core';
import type { SoftwareQualityContract } from '@agent/core';

export interface ExtractRequirementsInput {
  mission_id: string;
  project_name: string;
  source_path: string;
  source_type?:
    | 'call_recording'
    | 'call_transcript'
    | 'meeting_notes'
    | 'document_pack'
    | 'chat_log'
    | 'mixed';
  language?: string;
  customer_name?: string;
  customer_person_slug?: string;
  customer_org?: string;
  prior_draft_ref?: string;
}

export async function extractRequirements(input: ExtractRequirementsInput) {
  if (!input.mission_id || !input.project_name || !input.source_path) {
    throw new Error('[extract_requirements] requires mission_id, project_name, and source_path');
  }
  const backend = getReasoningBackend();
  const sourceAbs = pathResolver.rootResolve(input.source_path);
  if (!safeExistsSync(sourceAbs)) {
    throw new Error(`[extract_requirements] source not found: ${input.source_path}`);
  }
  const sourceText = safeReadFile(sourceAbs, { encoding: 'utf8' }) as string;

  let priorDraft: unknown;
  if (input.prior_draft_ref) {
    const priorAbs = pathResolver.rootResolve(input.prior_draft_ref);
    if (safeExistsSync(priorAbs)) {
      priorDraft = JSON.parse(safeReadFile(priorAbs, { encoding: 'utf8' }) as string);
    }
  }

  const customer =
    input.customer_name || input.customer_person_slug || input.customer_org
      ? {
          ...(input.customer_name ? { name: input.customer_name } : {}),
          ...(input.customer_person_slug ? { person_slug: input.customer_person_slug } : {}),
          ...(input.customer_org ? { org: input.customer_org } : {}),
        }
      : undefined;

  const extracted = await backend.extractRequirements({
    sourceText,
    projectName: input.project_name,
    customer,
    language: input.language,
    priorDraft,
  });
  const draft = saveRequirementsDraft({
    missionId: input.mission_id,
    projectName: input.project_name,
    extracted,
    customer,
    elicitationSource: {
      type: input.source_type ?? 'meeting_notes',
      refs: [input.source_path],
      ...(input.language ? { language: input.language } : {}),
    },
    generatedBy: backend.name,
  });

  return {
    mission_id: input.mission_id,
    version: draft.version,
    draft_path: `active/missions/${input.mission_id}/evidence/requirements-draft.json`,
    completeness: evaluateRequirementsCompletenessGate(input.mission_id),
  };
}

export async function extractDesignSpec(input: {
  mission_id: string;
  project_name: string;
  requirements_draft_path?: string;
  additional_context?: string;
}) {
  if (!input.mission_id || !input.project_name) {
    throw new Error('[extract_design_spec] requires mission_id and project_name');
  }
  const backend = getReasoningBackend();
  const requirementsPath =
    input.requirements_draft_path ??
    `active/missions/${input.mission_id}/evidence/requirements-draft.json`;
  const abs = pathResolver.rootResolve(requirementsPath);
  const requirementsDraft = safeExistsSync(abs)
    ? JSON.parse(safeReadFile(abs, { encoding: 'utf8' }) as string)
    : readRequirementsDraft(input.mission_id);
  if (!requirementsDraft) {
    throw new Error(`[extract_design_spec] requirements draft not found at ${requirementsPath}`);
  }

  const extracted = await backend.extractDesignSpec({
    requirementsDraft,
    projectName: input.project_name,
    additionalContext: input.additional_context,
  });
  const saved = saveDesignSpec({
    missionId: input.mission_id,
    projectName: input.project_name,
    extracted,
    sourceRefs: [requirementsPath],
    generatedBy: backend.name,
  });
  return {
    mission_id: input.mission_id,
    version: saved.version,
    draft_path: `active/missions/${input.mission_id}/evidence/design-spec.json`,
    architecture_ready: evaluateArchitectureReadyGate(input.mission_id),
  };
}

export async function extractTestPlan(input: {
  mission_id: string;
  project_name: string;
  app_id?: string;
  requirements_draft_path?: string;
  design_spec_path?: string;
}) {
  if (!input.mission_id || !input.project_name) {
    throw new Error('[extract_test_plan] requires mission_id and project_name');
  }
  const backend = getReasoningBackend();
  const requirementsDraft =
    readRequirementsDraft(input.mission_id) ??
    (input.requirements_draft_path &&
    safeExistsSync(pathResolver.rootResolve(input.requirements_draft_path))
      ? JSON.parse(
          safeReadFile(pathResolver.rootResolve(input.requirements_draft_path), {
            encoding: 'utf8',
          }) as string
        )
      : null);
  if (!requirementsDraft) throw new Error('[extract_test_plan] requirements draft not found');

  const designSpec =
    readDesignSpec(input.mission_id) ??
    (input.design_spec_path && safeExistsSync(pathResolver.rootResolve(input.design_spec_path))
      ? JSON.parse(
          safeReadFile(pathResolver.rootResolve(input.design_spec_path), {
            encoding: 'utf8',
          }) as string
        )
      : undefined);
  const extracted = await backend.extractTestPlan({
    requirementsDraft,
    designSpec,
    projectName: input.project_name,
    appId: input.app_id,
  });
  const saved = saveTestPlan({
    missionId: input.mission_id,
    projectName: input.project_name,
    extracted,
    sourceRefs: [
      `active/missions/${input.mission_id}/evidence/requirements-draft.json`,
      ...(designSpec ? [`active/missions/${input.mission_id}/evidence/design-spec.json`] : []),
    ],
    generatedBy: backend.name,
  });
  const mustHaveIds: string[] = Array.isArray(requirementsDraft.functional_requirements)
    ? requirementsDraft.functional_requirements
        .filter((item: { priority?: string }) => item.priority === 'must')
        .map((item: { id: string }) => item.id)
    : [];
  return {
    mission_id: input.mission_id,
    version: saved.version,
    draft_path: `active/missions/${input.mission_id}/evidence/test-plan.json`,
    qa_ready: evaluateQaReadyGate(input.mission_id, mustHaveIds),
  };
}

export async function deriveTestInventory(input: {
  contract: SoftwareQualityContract;
  system_tags: string[];
  risk_refs: string[];
  additional_context?: string;
  project_id?: string;
}) {
  const { deriveTestInventory: derive } = await import('@agent/core');
  return derive({
    contract: input.contract,
    systemTags: input.system_tags,
    riskRefs: input.risk_refs,
    additionalContext: input.additional_context,
    projectId: input.project_id,
  });
}

export function evaluateRequirementsCompleteness(missionId: string) {
  return evaluateRequirementsCompletenessGate(missionId);
}

export function evaluateCustomerSignoff(missionId: string) {
  return evaluateCustomerSignoffGate(missionId);
}

export function evaluateArchitectureReady(missionId: string) {
  return evaluateArchitectureReadyGate(missionId);
}

export function evaluateQaReady(missionId: string, mustHaveIds: string[]) {
  return evaluateQaReadyGate(missionId, mustHaveIds);
}
