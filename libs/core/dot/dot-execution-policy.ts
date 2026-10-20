import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import type { DotWorkShape } from './dot-proposals.js';
import type { DotProposal } from './dot-proposals.js';
import type { DotCharter } from './dot-charter.js';

export interface DotExecutionPolicy {
  version: string;
  intake: {
    enabled: boolean;
    action_id: string;
    allowed_work_shapes: DotWorkShape[];
    max_proposals_per_wake: number;
  };
  learning: {
    enabled: boolean;
    l2_release_approvals: number;
    l3_release_approvals: number;
    l3_decay_days: number;
    metrics_days: number;
  };
}

const fallback: DotExecutionPolicy = {
  version: 'disabled',
  intake: {
    enabled: false,
    action_id: 'dot_intake_work',
    allowed_work_shapes: [],
    max_proposals_per_wake: 1,
  },
  learning: {
    enabled: false,
    l2_release_approvals: Number.MAX_SAFE_INTEGER,
    l3_release_approvals: Number.MAX_SAFE_INTEGER,
    l3_decay_days: 36500,
    metrics_days: 30,
  },
};
const catalog = defineCatalog<DotExecutionPolicy>({
  id: 'dot-execution-policy',
  path: () => pathResolver.knowledge('product/governance/dot-execution-policy.json'),
  schema: pathResolver.knowledge('product/schemas/dot-execution-policy.schema.json'),
  fallback,
  fallbackOnInvalid: true,
});
export function loadDotExecutionPolicy(): DotExecutionPolicy {
  try {
    return catalog.load();
  } catch {
    return structuredClone(fallback);
  }
}

/** This classifies the effect of ADMISSION, never the work described in prose. */
export function isDotIntakeAdmission(charter: DotCharter, proposal: DotProposal): boolean {
  const policy = loadDotExecutionPolicy().intake;
  return (
    policy.enabled &&
    charter.status === 'active' &&
    Boolean(charter.scope.tenant_slug) &&
    !proposal.continuous_work &&
    !proposal.front_desk_execution &&
    policy.allowed_work_shapes.includes(proposal.work_shape)
  );
}
