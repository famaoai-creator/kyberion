import { parseInformationAssetWorkBinding } from '../information-assets/work-types.js';
import type { DotCharter } from './dot-charter.js';
import type { DotProposal } from './dot-proposals.js';
export type DotScopedProposal = Pick<
  DotProposal,
  | 'action_id'
  | 'work_shape'
  | 'handoff_to'
  | 'pipeline_ref'
  | 'front_desk_execution'
  | 'continuous_work'
  | 'information_asset_work'
  | 'mission_admission'
>;
export function informationWorkProposalRefusal(
  charter: DotCharter,
  proposal: DotScopedProposal
): { ok: false; reason: string } | undefined {
  if (proposal.information_asset_work) {
    try {
      const binding = parseInformationAssetWorkBinding(proposal.information_asset_work);
      const scope = binding.observation.scope;
      if (
        scope.tenant_slug !== charter.scope.tenant_slug ||
        scope.organization_id !== charter.scope.organization_id ||
        scope.project_id !== charter.scope.project_id ||
        (proposal.work_shape !== 'pipeline' &&
          !(proposal.work_shape === 'mission' && proposal.mission_admission)) ||
        (proposal.work_shape === 'pipeline' && !!proposal.mission_admission) ||
        proposal.pipeline_ref !==
          'knowledge/product/pipeline-templates/information-asset-work.json' ||
        proposal.handoff_to ||
        proposal.continuous_work ||
        proposal.front_desk_execution
      )
        return {
          ok: false,
          reason: 'Information work requires matching entity scope and the trusted recipe pipeline',
        };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }

  return undefined;
}
