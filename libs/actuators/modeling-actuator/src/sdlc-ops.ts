import {
  readDesignSpec,
  saveDesignSpec,
  evaluateArchitectureReadyGate,
  evaluateQaReadyGate,
  saveTestPlan,
} from '@agent/core/sdlc-artifact-store';
import {
  evaluateCustomerSignoffGate,
  evaluateRequirementsCompletenessGate,
  readRequirementsDraft,
  saveRequirementsDraft,
  type RequirementsDraft,
} from '@agent/core/requirements-draft-store';
import { getReasoningBackend } from '@agent/core/reasoning-backend';
import { assertSafeRepositoryPath, safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { readJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import type { SoftwareQualityContract } from '@agent/core/software-quality';

export interface ExtractRequirementsInput {
  mission_id: string;
  project_name: string;
  source_path: string;
  source_type?:
    'call_recording' | 'call_transcript' | 'meeting_notes' | 'document_pack' | 'chat_log' | 'mixed';
  language?: string;
  customer_name?: string;
  customer_person_slug?: string;
  customer_org?: string;
  prior_draft_ref?: string;
}

function resolveRepositoryInput(ref: string): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), { allowMissingLeaf: true });
}

export async function extractRequirements(input: ExtractRequirementsInput) {
  if (!input.mission_id || !input.project_name || !input.source_path) {
    throw new Error('[extract_requirements] requires mission_id, project_name, and source_path');
  }
  const backend = getReasoningBackend();
  const sourceAbs = resolveRepositoryInput(input.source_path);
  if (!safeExistsSync(sourceAbs)) {
    throw new Error(`[extract_requirements] source not found: ${input.source_path}`);
  }
  const sourceText = safeReadFile(sourceAbs, { encoding: 'utf8' }) as string;

  let priorDraft: unknown;
  if (input.prior_draft_ref) {
    const priorAbs = resolveRepositoryInput(input.prior_draft_ref);
    if (safeExistsSync(priorAbs)) {
      priorDraft = readJson<unknown>(priorAbs);
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
  const abs = resolveRepositoryInput(requirementsPath);
  const requirementsDraft = safeExistsSync(abs)
    ? readJson<unknown>(abs)
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
    safeExistsSync(resolveRepositoryInput(input.requirements_draft_path))
      ? readJson<RequirementsDraft>(resolveRepositoryInput(input.requirements_draft_path))
      : null);
  if (!requirementsDraft) throw new Error('[extract_test_plan] requirements draft not found');

  const designSpec =
    readDesignSpec(input.mission_id) ??
    (input.design_spec_path && safeExistsSync(resolveRepositoryInput(input.design_spec_path))
      ? readJson<unknown>(resolveRepositoryInput(input.design_spec_path))
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
  const { deriveTestInventory: derive } = await import('@agent/core/software-quality-operations');
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
