import {
  loadMandateCatalog,
  evaluateMissionStartMandate,
  type MissionAdmissionRequest,
} from '../governance/mandate-shadow.js';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readJson } from '../foundation/json.js';
import { compileSchema } from '../foundation/ajv.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { DotProposal } from '../dot/dot-proposals.js';
import {
  dispatchDotProposals,
  type DotDispatchDeps,
  type DotDispatchResult,
} from '../dot/dot-dispatch.js';
import type { InformationAssetObservation } from './types.js';
import type { InformationAssetWorkBinding, InformationIntakeRecipe } from './work-types.js';
import { INFORMATION_ASSET_WORK_PIPELINE } from './work-types.js';
export { INFORMATION_ASSET_WORK_PIPELINE } from './work-types.js';
export const INFORMATION_INTAKE_RECIPE_PATH =
  'knowledge/product/orchestration/information-intake-recipes.json';
export function loadInformationIntakeRecipes(
  options: { rootDir?: string } = {}
): InformationIntakeRecipe[] {
  const root = options.rootDir ?? process.cwd();
  const schema = path.join(
    root,
    'knowledge/product/schemas/information-intake-recipes.schema.json'
  );
  const value = readJson<unknown>(path.join(root, INFORMATION_INTAKE_RECIPE_PATH));
  const validate = compileSchema(schema);
  if (!validate(value)) throw new Error('[INFORMATION_RECIPE_INVALID] Invalid recipe catalog');
  const recipes = (value as { recipes: InformationIntakeRecipe[] }).recipes;
  if (new Set(recipes.map((r) => r.recipe_id)).size !== recipes.length)
    throw new Error('[INFORMATION_RECIPE_INVALID] Duplicate recipe identity');
  return recipes;
}
export function informationAssetWorkKey(
  observation: InformationAssetObservation,
  recipe: InformationIntakeRecipe
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        observation.scope.tenant_slug,
        observation.scope.organization_id,
        observation.scope.project_id ?? null,
        observation.location_id,
        observation.subject_id,
        observation.change_id,
        observation.event_type,
        recipe.recipe_id,
        recipe.version,
        recipe.action,
        recipe.completion,
        recipe.requires_approval,
      ])
    )
    .digest('hex');
}
/** Match API facts only. Semantic classification happens in the bounded reasoning seam after admission. */
export function matchesInformationIntakeRecipe(
  observation: InformationAssetObservation,
  recipe: InformationIntakeRecipe
): boolean {
  if (
    observation.asset_type !== recipe.asset_type ||
    !recipe.event_types.includes(observation.event_type)
  )
    return false;
  const facts = observation.data;
  if (recipe.event_types[0] === observation.event_type) return true;
  switch (recipe.action) {
    case 'follow_up':
      return facts.reply_overdue === true;
    case 'review':
      return facts.review_requested === true;
    case 'review_update':
      return facts.additional_commits === true;
    case 'resolve_review':
      return typeof facts.unresolved_review_count === 'number' && facts.unresolved_review_count > 0;
    case 'investigate_ci':
      return facts.ci_failed === true;
    case 'triage_issue':
      return (
        (typeof facts.assignee === 'string' && facts.assignee.length > 0) ||
        (!!facts.assignee && typeof facts.assignee === 'object')
      );
    case 'approve_issue':
      return facts.approval_pending === true;
    case 'resolve_overdue':
      return (
        typeof facts.due_date === 'string' &&
        Date.parse(facts.due_date) < Date.parse(observation.observed_at) &&
        facts.resolved !== true
      );
    case 'request_information':
      return (
        facts.waiting_information === true ||
        facts.status === 'Waiting for information' ||
        (!!facts.status &&
          typeof facts.status === 'object' &&
          !Array.isArray(facts.status) &&
          facts.status.name === 'Waiting for information')
      );
    default:
      return true;
  }
}
/** Select current explicit internal admission authority; external service effects remain separately gated. */
export function resolveInformationAssetRecipeMissionAdmission(
  observation: InformationAssetObservation,
  recipe: InformationIntakeRecipe,
  charter: DotCharter
): MissionAdmissionRequest {
  const effects: Record<string, string> = {
    follow_up: 'google-workspace:gmail_reply',
    resolve_review: 'github:resolve_review_thread',
    approve_issue: 'jira:answer_request_approval',
    resolve_overdue: 'jira:transition_issue',
    request_information: 'jira:add_comment',
  };
  const refs = charter.authority.mission_mandate_refs ?? [];
  const catalog = loadMandateCatalog();
  for (const mandate of catalog.mandates.filter((m) => refs.includes(m.id))) {
    const facts = {
      work_type: 'information_asset.' + recipe.action,
      paths: [
        'active/organizations/confidential/' +
          observation.scope.tenant_slug +
          '/' +
          observation.scope.organization_id +
          '/',
      ],
      estimated_cost: 0,
      currency: mandate.authority?.currency ?? 'USD',
      external_effects: [effects[recipe.action]],
      risk_level: 3,
    };
    if (
      evaluateMissionStartMandate(
        { tenant_slug: observation.scope.tenant_slug, mandate_id: mandate.id, facts },
        { catalog }
      ).covered
    )
      return { mandate_ref: mandate.id, mandate_facts: facts };
  }
  throw new Error(
    '[INFORMATION_RECIPE_MISSION_MANDATE] Configure a current tenant-bound mission mandate for ' +
      recipe.recipe_id
  );
}
export function buildInformationAssetRecipeProposals(
  observation: InformationAssetObservation,
  charter: DotCharter,
  options: {
    rootDir?: string;
    recipeIds?: string[];
    recipes?: InformationIntakeRecipe[];
    missionAdmission?: MissionAdmissionRequest;
  } = {}
): DotProposal[] {
  const scope = {
    tenant_slug: charter.scope.tenant_slug,
    organization_id: charter.scope.organization_id,
    ...(charter.scope.project_id ? { project_id: charter.scope.project_id } : {}),
  };
  if (!isDeepStrictEqual(scope, observation.scope))
    throw new Error('[INFORMATION_RECIPE_SCOPE] Observation and Dot scope differ');
  if (!charter.authority.allowed_pipelines?.includes(INFORMATION_ASSET_WORK_PIPELINE))
    throw new Error(
      '[INFORMATION_RECIPE_PIPELINE] Dot must explicitly allow the information work pipeline'
    );
  const recipes = options.recipes ?? loadInformationIntakeRecipes(options);
  const selected = options.recipeIds ? new Set(options.recipeIds) : undefined;
  return recipes
    .filter(
      (recipe) =>
        (!selected || selected.has(recipe.recipe_id)) &&
        matchesInformationIntakeRecipe(observation, recipe)
    )
    .map((recipe) => {
      const {
        data: _data,
        source_url: _url,
        occurred_at: _occurred,
        observed_at: _observed,
        ...reference
      } = observation;
      const binding: InformationAssetWorkBinding = {
        version: 1,
        recipe_id: recipe.recipe_id,
        recipe_version: recipe.version,
        work_key: informationAssetWorkKey(observation, recipe),
        observation: reference,
      };
      const missionAdmission =
        recipe.completion === 'external_readback'
          ? (options.missionAdmission ??
            resolveInformationAssetRecipeMissionAdmission(observation, recipe, charter))
          : undefined;
      if (
        missionAdmission &&
        (!charter.authority.allowed_execution_shapes?.includes('mission') ||
          !charter.authority.mission_mandate_refs?.includes(missionAdmission.mandate_ref))
      )
        throw new Error(
          '[INFORMATION_RECIPE_MISSION_MANDATE] Dot must explicitly allow the selected mission mandate'
        );
      return {
        ...(missionAdmission ? { mission_admission: missionAdmission } : {}),
        action_id: 'dot_delegate_work',
        title: recipe.title,
        objective: recipe.title + ' for source object ' + observation.subject_id,
        work_shape: missionAdmission ? 'mission' : 'pipeline',
        pipeline_ref: INFORMATION_ASSET_WORK_PIPELINE,
        requested_decision: recipe.requires_approval ? 'approve' : 'auto',
        information_asset_work: binding,
      } as DotProposal;
    });
}
/** Every proposal still traverses ordinary Dot authority, admission and capacity gates. */
export function dispatchInformationAssetRecipes(
  observation: InformationAssetObservation,
  charter: DotCharter,
  deps: DotDispatchDeps & { recipeIds?: string[]; recipes?: InformationIntakeRecipe[] } = {}
): DotDispatchResult[] {
  return buildInformationAssetRecipeProposals(observation, charter, deps).map((proposal) => {
    const binding = (
      proposal as DotProposal & { information_asset_work: InformationAssetWorkBinding }
    ).information_asset_work;
    return dispatchDotProposals(charter, [proposal], {
      ...deps,
      operationKey: 'information-asset:' + binding.work_key,
    });
  });
}
